import { normalizeLoraBinding } from '../src/lib/loraCompatibility.mjs'
import {
  assertWorkflowLoraBindingsCompatible,
  assertWorkflowLoraControlsMatchBindings,
} from '../src/lib/workflowRecipes.mjs'

function fail(code, message) {
  throw Object.assign(new Error(message), { code, status: 409 })
}

function canonicalName(value) {
  const name = value.replace(/\\/gu, '/')
  return process.platform === 'win32' ? name.toLocaleLowerCase('en-US') : name
}

// Recipes and execution share the same file/identity check; neither trusts a
// previously successful inspection or a caller-supplied filename.
export async function verifyWorkflowLoraBindings(catalog, input, workflow, values = {}) {
  const bindings = assertWorkflowLoraBindingsCompatible(input, workflow)
  assertWorkflowLoraControlsMatchBindings(bindings, values)
  if (!bindings.length) return []
  const { models, warnings } = await catalog.list()
  if (warnings.some((warning) => /LIMIT|FAILED|SYMLINK/u.test(warning))) {
    fail('LORA_CATALOG_INCOMPLETE', 'LoRA 目录未能完整扫描，请修复目录问题后重新复核')
  }
  const referenced = new Set(workflow.loraRequirements.names.map(canonicalName))
  const names = new Set()
  const records = []
  for (const binding of bindings) {
    const record = await catalog.resolveBinding(binding.id, binding.family)
    if (JSON.stringify(normalizeLoraBinding(record.binding)) !== JSON.stringify(binding)) {
      fail('LORA_BINDING_STALE', 'LoRA 绑定参数或文件身份已变化，请重新选择绑定')
    }
    const name = canonicalName(record.modelName)
    if (!referenced.has(name)) {
      fail('CUSTOM_WORKFLOW_LORA_NOT_REFERENCED', 'LoRA 绑定文件没有被当前工作流引用')
    }
    if (models.filter((model) => canonicalName(model.name) === name).length !== 1 || names.has(name)) {
      fail('CUSTOM_WORKFLOW_LORA_NAME_AMBIGUOUS', '多个受管目录存在同名 LoRA，请消除文件遮蔽后重试')
    }
    names.add(name)
    records.push({ binding, modelName: record.modelName, createdAt: record.createdAt })
  }
  return records
}
