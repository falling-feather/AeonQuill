import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LORA_BASE_FAMILIES,
  assertLoraBindingCompatible,
  normalizeLoraBinding,
} from '../src/lib/loraCompatibility.mjs'

const valid = () => ({
  id: 'character-v1',
  family: 'sd15',
  sha256: 'a'.repeat(64),
  role: 'character',
  strength: 1,
  clipStrength: 0.75,
  triggerWords: ['aeon-character', 'blue coat'],
})

test('normalizes a valid binding and reuses the shared strength ranges', () => {
  assert.deepEqual(normalizeLoraBinding(valid()), valid())
  assert.deepEqual(LORA_BASE_FAMILIES, ['sd15', 'sdxl', 'flux', 'qwen-image-edit', 'minimax-h3'])
  assert.equal(normalizeLoraBinding({ ...valid(), strength: -2 }).strength, -2)
  assert.throws(() => normalizeLoraBinding({ ...valid(), strength: 2.01 }), { code: 'WORKFLOW_CONTROL_VALUE_RANGE' })
  assert.throws(() => normalizeLoraBinding({ ...valid(), clipStrength: 2.01 }), { code: 'WORKFLOW_CONTROL_VALUE_RANGE' })
})

test('trigger byte validation works without the Node Buffer global', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')
  try {
    Reflect.deleteProperty(globalThis, 'Buffer')
    assert.equal(normalizeLoraBinding(valid()).triggerWords?.length, 2)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'Buffer', descriptor)
  }
})

test('rejects unknown fields, unsafe ids, invalid hashes and trigger limits', () => {
  assert.throws(() => normalizeLoraBinding({ ...valid(), extra: true }), { code: 'INVALID_LORA_BINDING_FIELDS' })
  assert.throws(() => normalizeLoraBinding({ ...valid(), id: '../character' }), { code: 'INVALID_LORA_ID' })
  assert.throws(() => normalizeLoraBinding({ ...valid(), sha256: 'A'.repeat(64) }), { code: 'INVALID_LORA_SHA256' })
  assert.throws(() => normalizeLoraBinding({ ...valid(), family: 'unknown' }), { code: 'INVALID_LORA_FAMILY' })
  assert.throws(() => normalizeLoraBinding({ ...valid(), triggerWords: Array.from({ length: 17 }, (_, index) => `word-${index}`) }), { code: 'INVALID_LORA_TRIGGER_WORDS' })
  assert.throws(() => normalizeLoraBinding({ ...valid(), triggerWords: ['C:\\private\\token'] }), { code: 'INVALID_LORA_TRIGGER_WORDS' })
})

test('rejects unknown or mismatched inspection evidence before workflow use', () => {
  const binding = normalizeLoraBinding(valid())
  assert.deepEqual(assertLoraBindingCompatible(binding, {
    family: 'sd15',
    sha256: 'a'.repeat(64),
    compatibility: 'compatible',
  }), binding)
  assert.throws(() => assertLoraBindingCompatible(binding, {
    family: 'sd15',
    sha256: 'a'.repeat(64),
    compatibility: 'unverified',
  }), { code: 'LORA_COMPATIBILITY_UNVERIFIED' })
  assert.throws(() => assertLoraBindingCompatible(binding, {
    family: 'sd15',
    sha256: 'a'.repeat(64),
    compatibility: 'incompatible',
  }), { code: 'LORA_COMPATIBILITY_INCOMPATIBLE' })
  assert.throws(() => assertLoraBindingCompatible(binding, {
    family: 'sdxl',
    sha256: 'a'.repeat(64),
    compatibility: 'compatible',
  }), { code: 'LORA_FAMILY_MISMATCH' })
  assert.throws(() => assertLoraBindingCompatible(binding, {
    family: 'sd15',
    sha256: 'b'.repeat(64),
    compatibility: 'compatible',
  }), { code: 'LORA_SHA256_MISMATCH' })
})
