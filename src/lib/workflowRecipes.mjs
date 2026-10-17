import { WORKFLOW_CONTROL_FIELDS, validateWorkflowControlValue } from './workflowControls.mjs'
import { normalizeLoraBinding } from './loraCompatibility.mjs'
export const WORKFLOW_RECIPE_SCHEMA_VERSION = 3
const LEGACY_INPUT_FIELDS = ['name', 'workflowId', 'workflowHash', 'mappingHash', 'parameters']
const INPUT_FIELDS = [...LEGACY_INPUT_FIELDS, 'weightSet', 'loraBindings']
const RECORD_FIELDS = ['id', ...INPUT_FIELDS, 'createdAt', 'updatedAt']
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const HASH = /^[a-f0-9]{64}$/u
const LORA_FAMILIES = new Set(['sd15', 'sdxl', 'flux', 'qwen-image-edit', 'minimax-h3'])
const LORA_ROLES = new Set(['style', 'character'])

function fail(code, message, status = 400) { throw Object.assign(new Error(message), { code, status }) }
function record(value, keys, label, required = keys, code = 'INVALID_WORKFLOW_RECIPE') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    fail(code, `${label}字段无效`)
  }
}

export function validateWorkflowWeightSet(input) {
  if (input === null) return null
  const keys = ['schemaVersion', 'registryVersion', 'family', 'profileId', 'samplingMode', 'artifacts']
  const code = 'INVALID_WORKFLOW_WEIGHT_SET'
  record(input, keys, '固定权重', keys, code)
  if (input.schemaVersion !== 1 || input.family !== 'minimax-h3'
    || typeof input.registryVersion !== 'string'
    || !/^aeonquill-h3-registry-v[1-9][0-9]*$/u.test(input.registryVersion)
    || !['fp8Scaled4060', 'int8ConvrotCu130'].includes(input.profileId)
    || !['base', 'turbo'].includes(input.samplingMode)) fail(code, '固定权重家族或版本无效')
  const roles = ['base', 'text-encoder', 'video-vae', 'audio-vae', ...(input.samplingMode === 'turbo' ? ['acceleration-lora'] : [])]
  if (!Array.isArray(input.artifacts) || input.artifacts.length !== roles.length) fail(code, '固定权重集合不完整')
  const byRole = new Map()
  for (const artifact of input.artifacts) {
    record(artifact, ['role', 'id', 'sha256'], '权重身份', undefined, code)
    if (!roles.includes(artifact.role) || byRole.has(artifact.role)
      || typeof artifact.id !== 'string' || !ID.test(artifact.id)
      || typeof artifact.sha256 !== 'string' || !HASH.test(artifact.sha256)) fail(code, '权重角色、ID 或 SHA-256 无效')
    byRole.set(artifact.role, { role: artifact.role, id: artifact.id, sha256: artifact.sha256 })
  }
  return {
    schemaVersion: 1, registryVersion: input.registryVersion, family: input.family,
    profileId: input.profileId, samplingMode: input.samplingMode, artifacts: roles.map((role) => byRole.get(role)),
  }
}

export function assertWorkflowWeightSetCompatible(actual, expected) {
  if (JSON.stringify(validateWorkflowWeightSet(actual)) !== JSON.stringify(validateWorkflowWeightSet(expected))) {
    fail('WORKFLOW_RECIPE_WEIGHT_STALE', '登记权重或兼容组合已变化，请核对工作流后重新保存配方', 409)
  }
}

export function normalizeWorkflowLoraBindings(input) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input) || input.length > 2) fail('INVALID_LORA_BINDINGS', '最多保存两个 LoRA 绑定')
  const bindings = input.map((value) => normalizeLoraBinding(value))
  const ids = new Set()
  const roles = new Set()
  let family = null
  for (const binding of bindings) {
    if (!LORA_FAMILIES.has(binding.family)) fail('INVALID_LORA_BINDINGS', 'LoRA 家族无效')
    if (!LORA_ROLES.has(binding.role) || roles.has(binding.role)) fail('INVALID_LORA_BINDINGS', 'style/character 角色不能重复')
    if (ids.has(binding.id)) fail('INVALID_LORA_BINDINGS', 'LoRA 绑定 ID 不能重复')
    if (family !== null && family !== binding.family) fail('INVALID_LORA_BINDINGS', '同一配方的 LoRA 必须属于同一底模家族')
    ids.add(binding.id)
    roles.add(binding.role)
    family = binding.family
  }
  return bindings.slice().sort((left, right) => left.role.localeCompare(right.role) || left.id.localeCompare(right.id))
}

export function assertWorkflowLoraBindingsCompatible(input, workflow) {
  const bindings = normalizeWorkflowLoraBindings(input)
  if (!bindings.length) return bindings
  const requirements = workflow?.loraRequirements
  if (!requirements || !Array.isArray(requirements.names) || !requirements.family || !LORA_FAMILIES.has(requirements.family)) {
    fail('LORA_BASE_FAMILY_UNPROVEN', '当前工作流没有可证明的 LoRA 底模家族', 409)
  }
  if (!workflow?.mappings?.loraStrength) fail('LORA_STRENGTH_MAPPING_MISSING', '当前工作流没有映射 loraStrength，不能绑定用户 LoRA', 409)
  if (bindings.some((binding) => binding.family !== requirements.family)) {
    fail('LORA_FAMILY_MISMATCH', 'LoRA 绑定家族与当前工作流底模不匹配', 409)
  }
  if (bindings.some((binding) => binding.clipStrength !== undefined) && !workflow?.mappings?.loraClipStrength) {
    fail('LORA_CLIP_STRENGTH_MAPPING_MISSING', 'LoRA 绑定包含 CLIP 强度，但当前工作流没有映射 loraClipStrength', 409)
  }
  if (requirements.names.length < bindings.length) fail('LORA_MAPPING_TARGET_MISSING', '当前工作流的 LoRA 节点不足以承载绑定', 409)
  return bindings
}

export function assertWorkflowLoraControlsMatchBindings(bindings, values = {}) {
  const normalized = normalizeWorkflowLoraBindings(bindings)
  if (!normalized.length) return normalized
  const strengths = new Set(normalized.map((binding) => binding.strength))
  if (strengths.size !== 1) fail('LORA_STRENGTH_CONFLICT', '多个 LoRA 绑定的模型强度不一致', 409)
  const strength = normalized[0].strength
  if (values.loraStrength !== undefined && values.loraStrength !== strength) {
    fail('LORA_STRENGTH_MISMATCH', '任务 loraStrength 与 LoRA 绑定不一致', 409)
  }
  const clipBindings = normalized.filter((binding) => binding.clipStrength !== undefined)
  if (clipBindings.length) {
    const clipStrengths = new Set(clipBindings.map((binding) => binding.clipStrength))
    if (clipStrengths.size !== 1) fail('LORA_CLIP_STRENGTH_CONFLICT', '多个 LoRA 绑定的 CLIP 强度不一致', 409)
    const clipStrength = clipBindings[0].clipStrength
    if (values.loraClipStrength !== undefined && values.loraClipStrength !== clipStrength) {
      fail('LORA_CLIP_STRENGTH_MISMATCH', '任务 loraClipStrength 与 LoRA 绑定不一致', 409)
    }
  } else if (values.loraClipStrength !== undefined) {
    fail('LORA_CLIP_STRENGTH_MISMATCH', '任务提供了 CLIP 强度，但绑定没有对应强度', 409)
  }
  return normalized
}

function normalizeInput(input) {
  record(input, INPUT_FIELDS, '配方', LEGACY_INPUT_FIELDS)
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 80 || /\p{Cc}/u.test(name)) fail('INVALID_WORKFLOW_RECIPE', '配方名称需要 1–80 个可见字符')
  if (typeof input.workflowId !== 'string' || typeof input.workflowHash !== 'string' || typeof input.mappingHash !== 'string'
    || !ID.test(input.workflowId) || !HASH.test(input.workflowHash) || !HASH.test(input.mappingHash)) {
    fail('INVALID_WORKFLOW_RECIPE', '配方缺少有效工作流身份')
  }
  const values = input.parameters
  if (!values || typeof values !== 'object' || Array.isArray(values)
    || Object.keys(values).some((key) => !Object.hasOwn(WORKFLOW_CONTROL_FIELDS, key))) {
    fail('INVALID_WORKFLOW_RECIPE', '配方只能保存受控数值参数')
  }
  const parameters = {}
  for (const [key, value] of Object.entries(values)) {
    try { parameters[key] = validateWorkflowControlValue(key, value) }
    catch (error) { fail('RECIPE_PARAMETER_RANGE', error.message) }
  }
  return {
    name,
    workflowId: input.workflowId,
    workflowHash: input.workflowHash,
    mappingHash: input.mappingHash,
    parameters,
    weightSet: validateWorkflowWeightSet(input.weightSet ?? null),
    loraBindings: normalizeWorkflowLoraBindings(input.loraBindings),
  }
}

export function assertWorkflowRecipeCompatible(recipe, workflow) {
  if (!workflow || workflow.id !== recipe.workflowId) fail('WORKFLOW_RECIPE_MISSING', '配方对应的工作流已移除，请重新选择工作流', 409)
  if (recipe.workflowHash !== workflow.hash || recipe.mappingHash !== workflow.mappingHash) {
    fail('WORKFLOW_RECIPE_STALE', '工作流或参数映射已变更，请检查参数后另存新配方', 409)
  }
  if (!workflow.enabled) fail('WORKFLOW_RECIPE_DISABLED', '请先启用配方对应的工作流', 409)
  assertWorkflowWeightSetCompatible(recipe.weightSet ?? null, workflow.weightSet ?? null)
  assertWorkflowLoraBindingsCompatible(recipe.loraBindings ?? [], workflow)
  for (const key of Object.keys(recipe.parameters)) {
    if (!workflow.mappings?.[key]) fail('RECIPE_PARAMETER_NOT_MAPPED', `当前工作流没有 ${key} 参数映射`)
  }
  return recipe
}

export function validateWorkflowRecipeInput(input, workflow) {
  const normalized = normalizeInput(input)
  if (normalized.weightSet !== null) assertWorkflowWeightSetCompatible(normalized.weightSet, workflow?.weightSet ?? null)
  normalized.weightSet = validateWorkflowWeightSet(workflow?.weightSet ?? null)
  return assertWorkflowRecipeCompatible(normalized, workflow)
}

export function validateWorkflowRecipeRecord(input) {
  record(input, RECORD_FIELDS, '配方记录')
  const value = normalizeInput(Object.fromEntries(INPUT_FIELDS.map((key) => [key, input[key]])))
  if (typeof input.id !== 'string' || !ID.test(input.id)
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
    || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < input.createdAt) {
    fail('INVALID_WORKFLOW_RECIPE', '配方记录身份或时间无效')
  }
  return { id: input.id, ...value, createdAt: input.createdAt, updatedAt: input.updatedAt }
}

export function migrateWorkflowRecipeRecord(input, schemaVersion) {
  if (schemaVersion === 1 || schemaVersion === 2) {
    const legacyKeys = schemaVersion === 1
      ? ['id', ...LEGACY_INPUT_FIELDS, 'createdAt', 'updatedAt']
      : ['id', ...INPUT_FIELDS.filter((key) => key !== 'loraBindings'), 'createdAt', 'updatedAt']
    record(input, legacyKeys, '旧配方记录')
    return validateWorkflowRecipeRecord({ ...input, weightSet: input.weightSet ?? null, loraBindings: [] })
  }
  if (schemaVersion !== WORKFLOW_RECIPE_SCHEMA_VERSION) fail('INVALID_WORKFLOW_RECIPE', '配方版本无效')
  return validateWorkflowRecipeRecord(input)
}
