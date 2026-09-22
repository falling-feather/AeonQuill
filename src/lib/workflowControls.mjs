export const WORKFLOW_CONTROL_FIELDS = Object.freeze({
  seed: Object.freeze({ label: '随机种子', min: 0, max: Number.MAX_SAFE_INTEGER, step: 1, integer: true }),
  width: Object.freeze({ label: '宽度', min: 64, max: 8_192, step: 1, integer: true }),
  height: Object.freeze({ label: '高度', min: 64, max: 8_192, step: 1, integer: true }),
  frames: Object.freeze({ label: '帧数', min: 1, max: 4_096, step: 1, integer: true }),
  steps: Object.freeze({ label: '采样步数', min: 1, max: 200, step: 1, integer: true }),
  cfg: Object.freeze({ label: 'CFG', min: 0, max: 30, step: 0.1, integer: false }),
  denoise: Object.freeze({ label: '去噪强度', min: 0, max: 1, step: 0.05, integer: false }),
  loraStrength: Object.freeze({ label: 'LoRA 模型强度', min: -2, max: 2, step: 0.05, integer: false }),
  loraClipStrength: Object.freeze({ label: 'LoRA CLIP 强度', min: -2, max: 2, step: 0.05, integer: false }),
  controlStrength: Object.freeze({ label: 'ControlNet 强度', min: 0, max: 2, step: 0.05, integer: false }),
})

function controlError(message, code) {
  return Object.assign(new Error(message), { code })
}

export function validateWorkflowControlValue(role, value) {
  if (typeof role !== 'string' || !Object.hasOwn(WORKFLOW_CONTROL_FIELDS, role)) throw controlError(`未知工作流控制角色：${String(role)}`, 'WORKFLOW_CONTROL_ROLE_INVALID')
  const field = WORKFLOW_CONTROL_FIELDS[role]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw controlError(`${role} 必须是有限数值`, 'WORKFLOW_CONTROL_VALUE_INVALID')
  }
  if (field.integer && !Number.isSafeInteger(value)) {
    throw controlError(`${role} 必须是安全整数`, 'WORKFLOW_CONTROL_VALUE_INVALID')
  }
  if (value < field.min || value > field.max) {
    throw controlError(`${role} 超出受控范围 ${field.min}–${field.max}`, 'WORKFLOW_CONTROL_VALUE_RANGE')
  }
  return value
}
