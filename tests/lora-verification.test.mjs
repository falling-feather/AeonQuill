import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyWorkflowLoraBindings } from '../server/lora-verification.mjs'

const binding = { id: 'lora-style', family: 'qwen-image-edit', sha256: 'a'.repeat(64), role: 'style', strength: 0.7, triggerWords: ['ink'] }
const workflow = { mappings: { loraStrength: { nodeId: '2', input: 'strength_model' } }, loraRequirements: { family: 'qwen-image-edit', names: ['styles/ink.safetensors'] } }
const record = { binding, modelName: 'styles/ink.safetensors', createdAt: 1 }
function catalog(options = {}) {
  return {
    list: async () => ({ models: [{ id: 'model-1', name: record.modelName }], warnings: [], ...options.list }),
    resolveBinding: async (id, family) => {
      assert.equal(id, binding.id)
      assert.equal(family, binding.family)
      if (options.error) throw options.error
      return options.record ?? structuredClone(record)
    },
  }
}

test('LoRA recipe/execution verification rechecks file identity and controlled references', async () => {
  assert.deepEqual(await verifyWorkflowLoraBindings(catalog(), [binding], workflow, { loraStrength: 0.7 }), [record])
  assert.deepEqual(await verifyWorkflowLoraBindings(null, [], {}, {}), [])
  await assert.rejects(verifyWorkflowLoraBindings(catalog({ error: Object.assign(new Error('changed bytes'), { code: 'LORA_SHA256_MISMATCH' }) }), [binding], workflow), { code: 'LORA_SHA256_MISMATCH' })
  await assert.rejects(verifyWorkflowLoraBindings(catalog({ record: { ...record, binding: { ...binding, triggerWords: ['other'] } } }), [binding], workflow), { code: 'LORA_BINDING_STALE' })
  await assert.rejects(verifyWorkflowLoraBindings(catalog(), [binding], { ...workflow, loraRequirements: { ...workflow.loraRequirements, names: ['other.safetensors'] } }), { code: 'CUSTOM_WORKFLOW_LORA_NOT_REFERENCED' })
  await assert.rejects(verifyWorkflowLoraBindings(catalog(), [binding], workflow, { loraStrength: 0.8 }), { code: 'LORA_STRENGTH_MISMATCH' })
})

test('LoRA verification refuses ambiguous or incomplete managed-root scans', async () => {
  await assert.rejects(verifyWorkflowLoraBindings(catalog({ list: { models: [{ id: '1', name: record.modelName }, { id: '2', name: record.modelName }] } }), [binding], workflow), { code: 'CUSTOM_WORKFLOW_LORA_NAME_AMBIGUOUS' })
  for (const warning of ['LORA_SCAN_ENTRY_LIMIT:0', 'LORA_DIRECTORY_STAT_FAILED:0:.', 'LORA_SYMLINK_SKIPPED:0:other']) {
    await assert.rejects(verifyWorkflowLoraBindings(catalog({ list: { warnings: [warning] } }), [binding], workflow), { code: 'LORA_CATALOG_INCOMPLETE' })
  }
})
