import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVideoWorkflow, VIDEO_DURATIONS } from '../server/workflow-builder.mjs'
import { compileH3Prompt } from '../src/lib/video/h3PromptAgent.mjs'
import { createScheduling } from '../server/job-scheduler.mjs'
import * as policy from '../src/lib/video/videoPresetPolicy.mjs'

const request = (duration, overrides = {}) => ({
  mode: 'text-to-video', prompt: 'A continuous view of rain on an old bookshop window, with a slow camera push toward an inkstone.',
  scenario: 'cinematic', aspectRatio: '16:9', duration, preset: 'nativeBase', modelProfile: 'int8ConvrotCu130', seed: 20261024, audio: true,
  jobId: `native-duration-${duration}`, ...overrides,
})

test('one shared duration policy retains old frame counts and represents 8s/12s on the native H3 grid', () => {
  assert.deepEqual(VIDEO_DURATIONS, { 5: 124, 8: 192, 10: 243, 12: 294, 15: 362 })
  assert.equal(VIDEO_DURATIONS, policy.VIDEO_DURATION_FRAMES)
  assert.deepEqual(policy.VIDEO_DURATION_OPTIONS, [5, 8, 10, 12, 15])
  for (const frames of Object.values(VIDEO_DURATIONS)) assert.equal(frames % 17, 5)
  assert.equal(VIDEO_DURATIONS[8] / 24, 8)
  assert.equal(VIDEO_DURATIONS[12] / 24, 12.25)
})

test('8s/12s use a single native Base20 sampler and stronger exact chunking in T2V and I2V', async () => {
  for (const duration of [8, 12]) {
    for (const mode of ['text-to-video', 'image-to-video']) {
      const { workflow, metadata } = await buildVideoWorkflow(request(duration, { mode, ...(mode === 'image-to-video' ? { inputImageName: 'first.png' } : {}) }))
      assert.deepEqual(metadata.dimensions, { width: 1344, height: 768 })
      assert.equal(metadata.frames, duration === 8 ? 192 : 294)
      assert.equal(workflow['6'].inputs.length, metadata.frames)
      assert.equal(metadata.steps, 20)
      assert.equal(workflow['5'], undefined)
      assert.equal(workflow['18'].inputs.head_chunks, 28)
      assert.equal(workflow['19'].inputs.chunks, 16)
      assert.deepEqual(metadata.memoryOptimizations, { headChunks: 28, feedForwardChunks: 16, tokenThreshold: 4096 })
      assert.equal(Object.values(workflow).filter(n => n.class_type === 'SamplerCustomAdvanced').length, 1)
      assert.equal(metadata.postprocessor, null)
      assert.equal(metadata.delivery, 'native')
      const prompt = compileH3Prompt({ ...request(duration), sourcePrompt: request(duration).prompt, frameCount: metadata.frames })
      assert.equal(prompt.effectiveDurationSeconds, (metadata.frames - 1) / 24)
      assert.equal(prompt.shotPlan.at(-1).end, prompt.effectiveDurationSeconds)
    }
  }
})

test('longer support cannot bypass a requested duration budget or expand old native/Turbo presets', async () => {
  await assert.rejects(buildVideoWorkflow(request(5, { frameCount: 243 })), e => e.code === 'VIDEO_PRESET_FRAME_COUNT_UNSUPPORTED')
  await assert.rejects(buildVideoWorkflow(request(8, { frameCount: 294 })), e => e.code === 'VIDEO_PRESET_FRAME_COUNT_UNSUPPORTED')
  for (const duration of [8, 12]) {
    for (const preset of policy.VIDEO_PRESET_IDS.filter(id => id !== 'nativeBase')) {
      await assert.rejects(buildVideoWorkflow(request(duration, { preset })), e => e.code === 'VIDEO_PRESET_DURATION_UNSUPPORTED')
    }
  }
  const { workflow } = await buildVideoWorkflow(request(5))
  assert.equal(workflow['18'].inputs.head_chunks, 8)
  assert.equal(workflow['19'].inputs.chunks, 4)
})

test('native long jobs receive a bounded timeout that also applies after restart', () => {
  assert.equal(typeof policy.videoExecutionTimeoutMs, 'function')
  assert.equal(policy.videoExecutionTimeoutMs('nativeBase', 8), 4 * 60 * 60 * 1000)
  assert.equal(policy.videoExecutionTimeoutMs('nativeBase', 12), 8 * 60 * 60 * 1000)
  assert.equal(policy.videoExecutionTimeoutMs('nativeBase', 5), 2 * 60 * 60 * 1000)
  assert.equal(policy.videoExecutionTimeoutMs('cinemaBase', 10), 2 * 60 * 60 * 1000)
  const scheduling = createScheduling({ resourceClass: 'gpu', priority: 50, timeoutMs: policy.videoExecutionTimeoutMs('nativeBase', 12), idempotencyKey: 'native12' })
  assert.equal(scheduling.timeoutMs, 8 * 60 * 60 * 1000)
  assert.throws(() => createScheduling({ resourceClass: 'gpu', priority: 50, timeoutMs: 8 * 60 * 60 * 1000 + 1 }), e => e.code === 'INVALID_JOB_TIMEOUT')
})
