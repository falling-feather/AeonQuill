import { WORKFLOW_CONTROL_FIELDS, validateWorkflowControlValue } from './workflowControls.mjs'
export const WORKFLOW_RECIPE_SCHEMA_VERSION = 1
const INPUT_FIELDS = ['name', 'workflowId', 'workflowHash', 'mappingHash', 'parameters']
const RECORD_FIELDS = ['id', ...INPUT_FIELDS, 'createdAt', 'updatedAt']
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const HASH = /^[a-f0-9]{64}$/u

function fail(code, message, status = 400) { throw Object.assign(new Error(message), { code, status }) }
function record(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(value, key))) {
    fail('INVALID_WORKFLOW_RECIPE', `${label}字段无效`)
  }
}
function normalizeInput(input) {
  record(input, INPUT_FIELDS, '配方')
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
  return { name, workflowId: input.workflowId, workflowHash: input.workflowHash, mappingHash: input.mappingHash, parameters }
}

export function assertWorkflowRecipeCompatible(recipe, workflow) {
  if (!workflow || workflow.id !== recipe.workflowId) fail('WORKFLOW_RECIPE_MISSING', '配方对应的工作流已移除，请重新选择工作流', 409)
  if (recipe.workflowHash !== workflow.hash || recipe.mappingHash !== workflow.mappingHash) {
    fail('WORKFLOW_RECIPE_STALE', '工作流或参数映射已变更，请检查参数后另存新配方', 409)
  }
  if (!workflow.enabled) fail('WORKFLOW_RECIPE_DISABLED', '请先启用配方对应的工作流', 409)
  for (const key of Object.keys(recipe.parameters)) {
    if (!workflow.mappings?.[key]) fail('RECIPE_PARAMETER_NOT_MAPPED', `当前工作流没有 ${key} 参数映射`)
  }
  return recipe
}

export function validateWorkflowRecipeInput(input, workflow) {
  return assertWorkflowRecipeCompatible(normalizeInput(input), workflow)
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
