import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKFLOW_CONTROL_FIELDS,
  validateWorkflowControlValue,
} from '../src/lib/workflowControls.mjs'

test('workflow control fields expose the legacy integer controls and new float controls', () => {
  assert.deepEqual(Object.keys(WORKFLOW_CONTROL_FIELDS).sort(), [
    'cfg', 'controlStrength', 'denoise', 'frames', 'height', 'loraClipStrength',
    'loraStrength', 'seed', 'steps', 'width',
  ])
  assert.deepEqual(WORKFLOW_CONTROL_FIELDS.seed, {
    label: '随机种子', min: 0, max: Number.MAX_SAFE_INTEGER, step: 1, integer: true,
  })
  assert.deepEqual(WORKFLOW_CONTROL_FIELDS.cfg, {
    label: 'CFG', min: 0, max: 30, step: 0.1, integer: false,
  })
  assert.deepEqual(WORKFLOW_CONTROL_FIELDS.denoise, {
    label: '去噪强度', min: 0, max: 1, step: 0.05, integer: false,
  })
  assert.deepEqual(WORKFLOW_CONTROL_FIELDS.loraStrength, {
    label: 'LoRA 模型强度', min: -2, max: 2, step: 0.05, integer: false,
  })
  assert.deepEqual(WORKFLOW_CONTROL_FIELDS.loraClipStrength, {
    label: 'LoRA CLIP 强度', min: -2, max: 2, step: 0.05, integer: false,
  })
  assert.deepEqual(WORKFLOW_CONTROL_FIELDS.controlStrength, {
    label: 'ControlNet 强度', min: 0, max: 2, step: 0.05, integer: false,
  })
})

test('workflow controls accept legal decimals and preserve legacy integer behavior', () => {
  assert.equal(validateWorkflowControlValue('cfg', 7.35), 7.35)
  assert.equal(validateWorkflowControlValue('denoise', 0), 0)
  assert.equal(validateWorkflowControlValue('loraStrength', -2), -2)
  assert.equal(validateWorkflowControlValue('controlStrength', 2), 2)
  assert.equal(validateWorkflowControlValue('seed', Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
  assert.equal(validateWorkflowControlValue('width', 8192), 8192)
})

test('workflow controls reject unknown roles, non-finite values, wrong integer types, and out-of-range values', () => {
  assert.throws(() => validateWorkflowControlValue('unknown', 1), (error) => error.code === 'WORKFLOW_CONTROL_ROLE_INVALID')
  assert.throws(() => validateWorkflowControlValue('cfg', Number.NaN), (error) => error.code === 'WORKFLOW_CONTROL_VALUE_INVALID')
  assert.throws(() => validateWorkflowControlValue('cfg', Number.POSITIVE_INFINITY), (error) => error.code === 'WORKFLOW_CONTROL_VALUE_INVALID')
  assert.throws(() => validateWorkflowControlValue('cfg', '4'), (error) => error.code === 'WORKFLOW_CONTROL_VALUE_INVALID')
  assert.throws(() => validateWorkflowControlValue('seed', 1.5), (error) => error.code === 'WORKFLOW_CONTROL_VALUE_INVALID')
  assert.throws(() => validateWorkflowControlValue('cfg', 30.01), (error) => error.code === 'WORKFLOW_CONTROL_VALUE_RANGE')
  assert.throws(() => validateWorkflowControlValue('denoise', -0.01), (error) => error.code === 'WORKFLOW_CONTROL_VALUE_RANGE')
})
test('prototype property names are never valid control roles', () => {
  assert.throws(() => validateWorkflowControlValue('__proto__', 1), { code: 'WORKFLOW_CONTROL_ROLE_INVALID' })
  assert.throws(() => validateWorkflowControlValue('constructor', 1), { code: 'WORKFLOW_CONTROL_ROLE_INVALID' })
})
