import { validateWorkflowControlValue } from './workflowControls.mjs'

export const LORA_BASE_FAMILIES = Object.freeze([
  'sd15',
  'sdxl',
  'flux',
  'qwen-image-edit',
  'minimax-h3',
])

const FAMILY_SET = new Set(LORA_BASE_FAMILIES)
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const COMPATIBILITY = new Set(['compatible', 'incompatible', 'unverified'])
const ROLES = new Set(['style', 'character'])
const MAX_TRIGGER_WORDS = 16
const MAX_TRIGGER_WORD_LENGTH = 80
const MAX_TRIGGER_BYTES = 1_024

function loraError(code, message, status = 400, details) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) })
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw loraError('INVALID_LORA_BINDING', `${label}必须是对象`)
  }
  return value
}

function assertExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) {
    throw loraError('INVALID_LORA_BINDING_FIELDS', `${label}含未知字段`, 400, { fields: unknown })
  }
}

function normalizeTriggerWords(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_TRIGGER_WORDS) {
    throw loraError('INVALID_LORA_TRIGGER_WORDS', `triggerWords最多 ${MAX_TRIGGER_WORDS} 项`)
  }
  const words = value.map((word, index) => {
    if (typeof word !== 'string') throw loraError('INVALID_LORA_TRIGGER_WORDS', `triggerWords[${index}]必须是字符串`)
    const normalized = word.trim()
    if (!normalized || normalized.length > MAX_TRIGGER_WORD_LENGTH || /\p{Cc}/u.test(normalized)) {
      throw loraError('INVALID_LORA_TRIGGER_WORDS', `triggerWords[${index}]长度或字符无效`)
    }
    if (/[\\/]|:\/\//u.test(normalized)) {
      throw loraError('INVALID_LORA_TRIGGER_WORDS', `triggerWords[${index}]不能包含路径或 URL`)
    }
    return normalized
  })
  if (new Set(words).size !== words.length) throw loraError('INVALID_LORA_TRIGGER_WORDS', 'triggerWords不能重复')
  if (new TextEncoder().encode(words.join('\u0000')).byteLength > MAX_TRIGGER_BYTES) {
    throw loraError('INVALID_LORA_TRIGGER_WORDS', 'triggerWords总长度超过上限')
  }
  return words
}

export function normalizeLoraBinding(input) {
  const value = record(input, 'LoRA binding')
  assertExactKeys(value, ['id', 'family', 'sha256', 'role', 'strength', 'clipStrength', 'triggerWords'], 'LoRA binding')
  if (typeof value.id !== 'string' || !ID.test(value.id)) {
    throw loraError('INVALID_LORA_ID', 'LoRA id必须是安全标识符')
  }
  if (typeof value.family !== 'string' || !FAMILY_SET.has(value.family)) {
    throw loraError('INVALID_LORA_FAMILY', 'LoRA family不在受支持集合中')
  }
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    throw loraError('INVALID_LORA_SHA256', 'LoRA sha256必须是64位小写十六进制')
  }
  if (typeof value.role !== 'string' || !ROLES.has(value.role)) {
    throw loraError('INVALID_LORA_ROLE', 'LoRA role必须是style或character')
  }
  const strength = validateWorkflowControlValue('loraStrength', value.strength)
  const clipStrength = value.clipStrength === undefined
    ? undefined
    : validateWorkflowControlValue('loraClipStrength', value.clipStrength)
  const triggerWords = normalizeTriggerWords(value.triggerWords)
  return {
    id: value.id,
    family: value.family,
    sha256: value.sha256,
    role: value.role,
    strength,
    ...(clipStrength === undefined ? {} : { clipStrength }),
    ...(triggerWords === undefined ? {} : { triggerWords }),
  }
}

function expectedCompatibility(value) {
  const context = record(value, 'LoRA compatibility')
  assertExactKeys(context, ['family', 'sha256', 'compatibility'], 'LoRA compatibility')
  if (typeof context.family !== 'string' || !FAMILY_SET.has(context.family)) {
    throw loraError('INVALID_LORA_EXPECTED_FAMILY', '兼容性校验的family无效')
  }
  if (typeof context.sha256 !== 'string' || !SHA256.test(context.sha256)) {
    throw loraError('INVALID_LORA_EXPECTED_SHA256', '兼容性校验的sha256无效')
  }
  if (typeof context.compatibility !== 'string' || !COMPATIBILITY.has(context.compatibility)) {
    throw loraError('INVALID_LORA_COMPATIBILITY', '兼容性状态无效')
  }
  return context
}

export function assertLoraBindingCompatible(binding, expected) {
  const normalized = normalizeLoraBinding(binding)
  const context = expectedCompatibility(expected)
  if (context.compatibility === 'unverified') {
    throw loraError('LORA_COMPATIBILITY_UNVERIFIED', 'LoRA兼容性无法证明，请先完成受管检查', 409)
  }
  if (context.compatibility === 'incompatible') {
    throw loraError('LORA_COMPATIBILITY_INCOMPATIBLE', 'LoRA与当前底模家族不兼容', 409)
  }
  if (context.family !== normalized.family) {
    throw loraError('LORA_FAMILY_MISMATCH', 'LoRA绑定的底模家族不匹配', 409)
  }
  if (context.sha256 !== normalized.sha256) {
    throw loraError('LORA_SHA256_MISMATCH', 'LoRA文件SHA-256不匹配', 409)
  }
  return normalized
}
