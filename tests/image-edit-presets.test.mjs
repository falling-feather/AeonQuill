import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getImageEditPreset,
  IMAGE_EDIT_PRESETS,
} from '../src/lib/imageEditPresets.mjs'

test('image edit presets expose one stable base preset and one Lightning experiment', () => {
  assert.deepEqual(Object.keys(IMAGE_EDIT_PRESETS), ['base40', 'lightning4'])
  assert.equal(IMAGE_EDIT_PRESETS.base40.id, 'base40')
  assert.equal(IMAGE_EDIT_PRESETS.base40.label, '标准 · 40 步')
  assert.equal(IMAGE_EDIT_PRESETS.base40.steps, 40)
  assert.equal(IMAGE_EDIT_PRESETS.base40.cfg, 4)
  assert.equal(IMAGE_EDIT_PRESETS.base40.sampler, 'euler')
  assert.equal(IMAGE_EDIT_PRESETS.base40.scheduler, 'simple')
  assert.equal(IMAGE_EDIT_PRESETS.base40.denoise, 1)
  assert.equal(IMAGE_EDIT_PRESETS.base40.shift, 3.1)
  assert.equal(IMAGE_EDIT_PRESETS.base40.version, 'qwen-image-edit-2511-int8-v1')
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.id, 'lightning4')
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.label, 'Lightning · 4 步')
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.steps, 4)
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.cfg, 1)
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.sampler, 'euler')
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.scheduler, 'simple')
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.denoise, 1)
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.shift, 3.1)
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.loraStrength, 1)
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.loraArtifactId, 'qwen-image-edit-2511-lightning4-bf16-v1')
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.version, 'qwen-image-edit-2511-int8-lightning4-v1')
  assert.equal(IMAGE_EDIT_PRESETS.lightning4.maturity, 'experimental')
})

test('getImageEditPreset defaults to base40 and rejects unknown values', () => {
  assert.equal(getImageEditPreset().id, 'base40')
  assert.equal(getImageEditPreset('base40'), IMAGE_EDIT_PRESETS.base40)
  assert.equal(getImageEditPreset('lightning4'), IMAGE_EDIT_PRESETS.lightning4)
  assert.throws(
    () => getImageEditPreset('character-lora'),
    (error) => error.code === 'INVALID_IMAGE_EDIT_PRESET',
  )
})
