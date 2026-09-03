import {
  assertCanvasDocument,
  compileCanvasToolInvocation,
  createCanvasDraft,
} from '../canvasCore.mjs'
import {
  applyPixelCommand,
  assertPixelDocument,
  createPixelCommand,
} from '../pixel/pixelCore.mjs'
import {
  assertGenerationPlan,
  assertStoryProject,
} from '../story/storyProject.mjs'
import {
  applyVideoProductionCommand,
  createVideoProductionCommand,
  migrateVideoProductionProject,
} from '../story/productionPipeline.mjs'

export const CREATIVE_PLAN_SCHEMA_VERSION = 1
export const CREATIVE_PLAN_APPROVAL_SCHEMA_VERSION = 1
export const CREATIVE_PLAN_PREVIEW_SCHEMA_VERSION = 1
export const CREATIVE_PLAN_RECEIPT_SCHEMA_VERSION = 1

const MODE_IDS = new Set(['balanced', 'pixel', 'smart-video'])
const SOURCE_KINDS = new Set(['deterministic-local', 'byok-text'])
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_PLAN_BYTES = 256 * 1024
const MAX_STEPS = 50
const MAX_JSON_DEPTH = 16
const MAX_JSON_KEYS = 4_000
const MAX_JSON_STRING = 64 * 1024

const PLAN_FIELDS = new Set([
  'schemaVersion', 'id', 'projectId', 'documentId', 'modeId', 'baseRevision',
  'title', 'objective', 'source', 'steps', 'createdAt',
])
const SOURCE_FIELDS = new Set(['kind', 'agentRole', 'modelId', 'requestHash'])
const STEP_FIELDS = new Set(['id', 'toolId', 'summary', 'input', 'sourceAssets'])
const SOURCE_ASSET_FIELDS = new Set(['assetId', 'versionId', 'sha256'])
const APPROVED_FIELDS = new Set(['schemaVersion', 'plan', 'approval'])
const APPROVAL_FIELDS = new Set(['approvedBy', 'approvedAt', 'planSha256'])
const RECEIPT_FIELDS = new Set([
  'schemaVersion', 'id', 'planId', 'projectId', 'documentId', 'modeId',
  'baseRevision', 'resultRevision', 'title', 'planSha256', 'source', 'steps',
  'approvedAt', 'committedAt',
])
const RECEIPT_STEP_FIELDS = new Set(['id', 'toolId', 'inputSha256', 'sourceAssets'])

const PIXEL_TOOL_TYPES = new Map([
  ['pixel.pixels.paint', 'pixels.paint'],
  ['pixel.pixels.erase', 'pixels.erase'],
  ['pixel.pixels.patch', 'pixels.patch'],
  ['pixel.palette.add', 'palette.add'],
  ['pixel.frames.duration.set', 'frames.duration.set'],
  ['pixel.cels.copy', 'cels.copy'],
])

const VIDEO_TOOL_TYPES = new Map([
  ['video.project.patch', 'project.patch'],
  ['video.node.edit', 'node.edit'],
  ['video.proposal.accept', 'proposal.accept'],
  ['video.proposal.reject', 'proposal.reject'],
])

export class CreativePlanError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'CreativePlanError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new CreativePlanError(code, message, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return globalThis.structuredClone(value)
}

function exactKeys(value, fields, label) {
  if (!isRecord(value)) fail('INVALID_OBJECT', `${label} must be an object`)
  const actual = Object.keys(value)
  const unknown = actual.filter((key) => !fields.has(key))
  const missing = [...fields].filter((key) => !(key in value))
  if (unknown.length || missing.length) {
    fail('UNKNOWN_FIELD', `${label} fields do not match the supported schema`, { label, unknown, missing })
  }
  return value
}

function text(value, label, { minimum = 0, maximum = MAX_JSON_STRING, nullable = false } = {}) {
  if (nullable && value === null) return value
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    fail('INVALID_TEXT', `${label} must contain ${minimum}-${maximum} characters`)
  }
  return value
}

function id(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('INVALID_ID', `${label} is invalid`)
  return value
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INTEGER', `${label} must be an integer >= 0`)
  return value
}

function sha256(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail('INVALID_SHA256', `${label} must be a lowercase SHA-256`)
  return value
}

function assertJsonValue(value, label, state = { depth: 0, counter: { keys: 0 }, seen: new Set() }) {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    text(value, label)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_JSON_VALUE', `${label} contains a non-finite number`)
    return
  }
  if (typeof value !== 'object') fail('INVALID_JSON_VALUE', `${label} must contain only JSON values`)
  if (state.seen.has(value)) fail('INVALID_JSON_VALUE', `${label} cannot contain circular values`)
  if (state.depth >= MAX_JSON_DEPTH) fail('PLAN_COMPLEXITY_LIMIT', `${label} exceeds the maximum nesting depth`)
  state.seen.add(value)
  const next = { ...state, depth: state.depth + 1 }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`, next))
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('UNSAFE_JSON_KEY', `${label} contains an unsafe key`)
      state.counter.keys += 1
      if (state.counter.keys > MAX_JSON_KEYS) fail('PLAN_COMPLEXITY_LIMIT', `${label} contains too many fields`)
      text(key, `${label} key`, { minimum: 1, maximum: 160 })
      assertJsonValue(child, `${label}.${key}`, next)
    }
  }
  state.seen.delete(value)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

async function digest(value) {
  if (!globalThis.crypto?.subtle) fail('CRYPTO_UNAVAILABLE', 'Web Crypto SHA-256 is unavailable')
  const encoded = new TextEncoder().encode(canonicalJson(value))
  const result = await globalThis.crypto.subtle.digest('SHA-256', encoded)
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function assertSource(source, label = 'plan.source') {
  exactKeys(source, SOURCE_FIELDS, label)
  if (!SOURCE_KINDS.has(source.kind)) fail('INVALID_SOURCE', `${label}.kind is unsupported`)
  text(source.agentRole, `${label}.agentRole`, { minimum: 1, maximum: 80 })
  text(source.modelId, `${label}.modelId`, { maximum: 160, nullable: true })
  sha256(source.requestHash, `${label}.requestHash`, { nullable: true })
  if (source.kind === 'deterministic-local' && (source.modelId !== null || source.requestHash !== null)) {
    fail('INVALID_SOURCE', 'Deterministic local plans cannot claim a remote model or request hash')
  }
  if (source.kind === 'byok-text' && (!source.modelId || !source.requestHash)) {
    fail('INVALID_SOURCE', 'BYOK plans require a model id and redacted request hash')
  }
  return source
}

function assertSourceAssets(assets, label) {
  if (!Array.isArray(assets) || assets.length > 32) fail('INVALID_SOURCE_ASSETS', `${label} must contain at most 32 entries`)
  const identities = new Set()
  assets.forEach((asset, index) => {
    const path = `${label}[${index}]`
    exactKeys(asset, SOURCE_ASSET_FIELDS, path)
    sha256(asset.assetId, `${path}.assetId`)
    id(asset.versionId, `${path}.versionId`)
    sha256(asset.sha256, `${path}.sha256`)
    const identity = `${asset.assetId}:${asset.versionId}`
    if (identities.has(identity)) fail('DUPLICATE_SOURCE_ASSET', `${path} duplicates an earlier source`)
    identities.add(identity)
  })
  return assets
}

export function assertCreativePlan(input) {
  const plan = exactKeys(input, PLAN_FIELDS, 'plan')
  if (plan.schemaVersion !== CREATIVE_PLAN_SCHEMA_VERSION) fail('UNSUPPORTED_PLAN_SCHEMA', 'Unsupported CreativePlan schema')
  id(plan.id, 'plan.id')
  id(plan.projectId, 'plan.projectId')
  id(plan.documentId, 'plan.documentId')
  if (!MODE_IDS.has(plan.modeId)) fail('INVALID_MODE', `Unsupported plan mode: ${String(plan.modeId)}`)
  integer(plan.baseRevision, 'plan.baseRevision')
  text(plan.title, 'plan.title', { minimum: 1, maximum: 120 })
  text(plan.objective, 'plan.objective', { minimum: 1, maximum: 2_000 })
  assertSource(plan.source)
  integer(plan.createdAt, 'plan.createdAt')
  if (!Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > MAX_STEPS) {
    fail('INVALID_PLAN_STEPS', `plan.steps must contain 1-${MAX_STEPS} steps`)
  }
  const stepIds = new Set()
  plan.steps.forEach((step, index) => {
    const path = `plan.steps[${index}]`
    exactKeys(step, STEP_FIELDS, path)
    id(step.id, `${path}.id`)
    if (stepIds.has(step.id)) fail('DUPLICATE_STEP_ID', `Duplicate plan step id: ${step.id}`)
    stepIds.add(step.id)
    text(step.toolId, `${path}.toolId`, { minimum: 1, maximum: 160 })
    text(step.summary, `${path}.summary`, { minimum: 1, maximum: 500 })
    if (!isRecord(step.input)) fail('INVALID_TOOL_INPUT', `${path}.input must be an object`)
    assertJsonValue(step.input, `${path}.input`)
    assertSourceAssets(step.sourceAssets, `${path}.sourceAssets`)
  })
  const bytes = new TextEncoder().encode(JSON.stringify(plan)).byteLength
  if (bytes > MAX_PLAN_BYTES) fail('PLAN_SIZE_LIMIT', `CreativePlan exceeds ${MAX_PLAN_BYTES} bytes`, { bytes })
  return plan
}

export function createCreativePlan(input) {
  return clone(assertCreativePlan({
    schemaVersion: CREATIVE_PLAN_SCHEMA_VERSION,
    ...input,
  }))
}

export async function hashCreativePlan(input) {
  return digest(assertCreativePlan(input))
}

export async function approveCreativePlan(input, options = {}) {
  const plan = clone(assertCreativePlan(input))
  const approvedAt = integer(options.approvedAt ?? Date.now(), 'approval.approvedAt')
  if (approvedAt < plan.createdAt) fail('INVALID_APPROVAL_TIME', 'Approval cannot predate the plan')
  return {
    schemaVersion: CREATIVE_PLAN_APPROVAL_SCHEMA_VERSION,
    plan,
    approval: {
      approvedBy: 'user',
      approvedAt,
      planSha256: await hashCreativePlan(plan),
    },
  }
}

export async function assertApprovedCreativePlan(input) {
  const approved = exactKeys(input, APPROVED_FIELDS, 'approvedPlan')
  if (approved.schemaVersion !== CREATIVE_PLAN_APPROVAL_SCHEMA_VERSION) fail('UNSUPPORTED_APPROVAL_SCHEMA', 'Unsupported CreativePlan approval schema')
  const plan = assertCreativePlan(approved.plan)
  exactKeys(approved.approval, APPROVAL_FIELDS, 'approvedPlan.approval')
  if (approved.approval.approvedBy !== 'user') fail('INVALID_APPROVER', 'CreativePlan must be approved by the local user')
  integer(approved.approval.approvedAt, 'approvedPlan.approval.approvedAt')
  if (approved.approval.approvedAt < plan.createdAt) fail('INVALID_APPROVAL_TIME', 'Approval cannot predate the plan')
  sha256(approved.approval.planSha256, 'approvedPlan.approval.planSha256')
  const expected = await hashCreativePlan(plan)
  if (expected !== approved.approval.planSha256) {
    fail('PLAN_APPROVAL_MISMATCH', 'CreativePlan changed after approval', { expected, received: approved.approval.planSha256 })
  }
  return approved
}

function assertDocumentIdentity(body, plan, workspaceRevision) {
  integer(workspaceRevision, 'workspaceRevision')
  if (workspaceRevision !== plan.baseRevision) {
    fail('REVISION_CONFLICT', `Plan expects workspace revision ${plan.baseRevision}, current revision is ${workspaceRevision}`)
  }
  if (plan.modeId === 'balanced') {
    assertCanvasDocument(body)
    if (body.id !== plan.documentId) fail('DOCUMENT_ID_MISMATCH', 'Canvas document does not match CreativePlan')
    if (body.revision !== workspaceRevision) fail('REVISION_CONFLICT', 'Canvas and workspace revisions are not aligned')
    return
  }
  if (plan.modeId === 'pixel') {
    assertPixelDocument(body)
    if (body.id !== plan.documentId) fail('DOCUMENT_ID_MISMATCH', 'Pixel document does not match CreativePlan')
    if (body.revision !== workspaceRevision) fail('REVISION_CONFLICT', 'Pixel and workspace revisions are not aligned')
    return
  }
  if (!isRecord(body) || body.schemaVersion !== 2) fail('UNSUPPORTED_DOCUMENT_SCHEMA', 'Smart video document schema must equal 2')
  const project = assertStoryProject(body.project)
  assertGenerationPlan(body.plan, project)
  migrateVideoProductionProject(body.production, { story: project })
  if (project.id !== plan.documentId) fail('DOCUMENT_ID_MISMATCH', 'Smart video document does not match CreativePlan')
}

function compileBalanced(body, plan, now) {
  const commands = plan.steps.map((step) => compileCanvasToolInvocation(body, {
    toolId: step.toolId,
    callId: step.id,
    actor: 'agent',
    input: step.input,
  }))
  const draft = createCanvasDraft(body, commands, { id: `draft-${plan.id}`, now })
  return { document: draft.preview, commands }
}

function compilePixel(body, plan) {
  let document = clone(body)
  const commands = []
  const inverses = []
  for (const step of plan.steps) {
    const type = PIXEL_TOOL_TYPES.get(step.toolId)
    if (!type) fail('TOOL_NOT_FOUND', `Unknown pixel agent tool: ${step.toolId}`)
    const command = createPixelCommand(document, type, step.input, { id: step.id, actor: 'agent' })
    const result = applyPixelCommand(document, command)
    document = result.document
    commands.push(command)
    inverses.unshift(result.inverse)
  }
  return { document, commands, inverses }
}

function compileSmartVideo(body, plan, now) {
  let production = migrateVideoProductionProject(body.production, { story: body.project })
  const commands = []
  for (const [index, step] of plan.steps.entries()) {
    const type = VIDEO_TOOL_TYPES.get(step.toolId)
    if (!type) fail('TOOL_NOT_FOUND', `Unknown smart-video agent tool: ${step.toolId}`)
    const command = createVideoProductionCommand(production, type, step.input, {
      id: step.id,
      actor: 'orchestrator',
    })
    production = applyVideoProductionCommand(production, command, {
      now: Math.max(production.updatedAt, now + index),
    })
    commands.push(command)
  }
  return { document: { ...clone(body), production }, commands }
}

export function previewCreativePlan(modeDocument, planInput, options = {}) {
  const plan = assertCreativePlan(planInput)
  const workspaceRevision = options.workspaceRevision ?? plan.baseRevision
  const now = integer(options.now ?? Date.now(), 'preview.now')
  const body = clone(modeDocument)
  assertDocumentIdentity(body, plan, workspaceRevision)
  let compiled
  try {
    compiled = plan.modeId === 'balanced'
      ? compileBalanced(body, plan, now)
      : plan.modeId === 'pixel'
        ? compilePixel(body, plan)
        : compileSmartVideo(body, plan, now)
  } catch (error) {
    if (error instanceof CreativePlanError) throw error
    fail(error?.code || 'TOOL_VALIDATION_FAILED', error?.message || 'CreativePlan tool validation failed')
  }
  const resultRevision = plan.modeId === 'smart-video'
    ? workspaceRevision + 1
    : compiled.document.revision
  return {
    schemaVersion: CREATIVE_PLAN_PREVIEW_SCHEMA_VERSION,
    planId: plan.id,
    modeId: plan.modeId,
    baseRevision: plan.baseRevision,
    resultRevision,
    document: compiled.document,
    commands: compiled.commands,
    summaries: plan.steps.map(({ id: stepId, toolId, summary }) => ({ stepId, toolId, summary })),
  }
}

export async function executeApprovedCreativePlan(modeDocument, approvedInput, options = {}) {
  const approved = await assertApprovedCreativePlan(approvedInput)
  const committedAt = integer(options.committedAt ?? Date.now(), 'receipt.committedAt')
  if (committedAt < approved.approval.approvedAt) fail('INVALID_COMMIT_TIME', 'Commit cannot predate approval')
  const preview = previewCreativePlan(modeDocument, approved.plan, {
    workspaceRevision: options.workspaceRevision ?? approved.plan.baseRevision,
    now: committedAt,
  })
  const steps = await Promise.all(approved.plan.steps.map(async (step) => ({
    id: step.id,
    toolId: step.toolId,
    inputSha256: await digest(step.input),
    sourceAssets: clone(step.sourceAssets),
  })))
  const receipt = {
    schemaVersion: CREATIVE_PLAN_RECEIPT_SCHEMA_VERSION,
    id: `agent-receipt-${approved.approval.planSha256.slice(0, 32)}`,
    planId: approved.plan.id,
    projectId: approved.plan.projectId,
    documentId: approved.plan.documentId,
    modeId: approved.plan.modeId,
    baseRevision: approved.plan.baseRevision,
    resultRevision: preview.resultRevision,
    title: approved.plan.title,
    planSha256: approved.approval.planSha256,
    source: clone(approved.plan.source),
    steps,
    approvedAt: approved.approval.approvedAt,
    committedAt,
  }
  assertCreativePlanReceipt(receipt)
  return { document: preview.document, receipt, commands: preview.commands }
}

export function assertCreativePlanReceipt(input) {
  const receipt = exactKeys(input, RECEIPT_FIELDS, 'receipt')
  if (receipt.schemaVersion !== CREATIVE_PLAN_RECEIPT_SCHEMA_VERSION) fail('UNSUPPORTED_RECEIPT_SCHEMA', 'Unsupported CreativePlan receipt schema')
  id(receipt.id, 'receipt.id')
  id(receipt.planId, 'receipt.planId')
  id(receipt.projectId, 'receipt.projectId')
  id(receipt.documentId, 'receipt.documentId')
  if (!MODE_IDS.has(receipt.modeId)) fail('INVALID_MODE', `Unsupported receipt mode: ${String(receipt.modeId)}`)
  integer(receipt.baseRevision, 'receipt.baseRevision')
  integer(receipt.resultRevision, 'receipt.resultRevision')
  if (receipt.resultRevision <= receipt.baseRevision) fail('INVALID_RECEIPT_REVISION', 'Receipt result revision must advance')
  text(receipt.title, 'receipt.title', { minimum: 1, maximum: 120 })
  sha256(receipt.planSha256, 'receipt.planSha256')
  assertSource(receipt.source, 'receipt.source')
  if (!Array.isArray(receipt.steps) || !receipt.steps.length || receipt.steps.length > MAX_STEPS) fail('INVALID_RECEIPT_STEPS', 'Receipt steps are invalid')
  receipt.steps.forEach((step, index) => {
    const path = `receipt.steps[${index}]`
    exactKeys(step, RECEIPT_STEP_FIELDS, path)
    id(step.id, `${path}.id`)
    text(step.toolId, `${path}.toolId`, { minimum: 1, maximum: 160 })
    sha256(step.inputSha256, `${path}.inputSha256`)
    assertSourceAssets(step.sourceAssets, `${path}.sourceAssets`)
  })
  integer(receipt.approvedAt, 'receipt.approvedAt')
  integer(receipt.committedAt, 'receipt.committedAt')
  if (receipt.committedAt < receipt.approvedAt) fail('INVALID_COMMIT_TIME', 'Receipt commit cannot predate approval')
  return receipt
}

export function creativePlanToolCatalog() {
  return {
    balanced: ['canvas.elements.add', 'canvas.elements.patch', 'canvas.elements.remove'],
    pixel: [...PIXEL_TOOL_TYPES.keys()],
    'smart-video': [...VIDEO_TOOL_TYPES.keys()],
  }
}
