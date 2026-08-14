import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildVideoWorkflow,
  REQUIRED_NODE_TYPES,
  VIDEO_DIMENSIONS,
  VIDEO_DURATIONS,
  VIDEO_PRESETS,
  WORKFLOW_VERSION,
  workflowCatalog,
} from '../server/workflow-builder.mjs'

function assertWorkflowGraph(workflow) {
  const ids = new Set(Object.keys(workflow))
  for (const [nodeId, node] of Object.entries(workflow)) {
    assert.equal(typeof node.class_type, 'string', `node ${nodeId} class_type`)
    assert.ok(REQUIRED_NODE_TYPES.includes(node.class_type), `node ${nodeId} uses registered class ${node.class_type}`)
    assert.equal(typeof node.inputs, 'object', `node ${nodeId} inputs`)
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1])) {
        assert.ok(ids.has(value[0]), `node ${nodeId}.${inputName} references existing node ${value[0]}`)
      }
    }
  }
}

test('builds every supported mode, preset, duration, and aspect ratio offline', async () => {
  for (const mode of ['text-to-video', 'image-to-video']) {
    for (const aspectRatio of Object.keys(VIDEO_DIMENSIONS)) {
      for (const duration of Object.keys(VIDEO_DURATIONS).map(Number)) {
        for (const preset of Object.keys(VIDEO_PRESETS)) {
          const { workflow, metadata } = await buildVideoWorkflow({
            mode,
            prompt: 'Offline workflow contract.',
            aspectRatio,
            duration,
            preset,
            seed: 7,
            audio: true,
            inputImageName: mode === 'image-to-video' ? 'first.png' : undefined,
            jobId: `qa-${mode}-${preset}`,
          })
          assertWorkflowGraph(workflow)
          assert.equal(metadata.version, WORKFLOW_VERSION)
          assert.equal(metadata.frames, VIDEO_DURATIONS[duration])
          assert.equal(metadata.steps, VIDEO_PRESETS[preset].steps)
          assert.ok(metadata.dimensions.width > 0 && metadata.dimensions.height > 0)
          assert.ok(workflow['15'].inputs.filename_prefix.startsWith('MiaoHui/'))
        }
      }
    }
  }
})

test('handles optional last frame, audio removal, and safe output prefixes', async () => {
  const { workflow } = await buildVideoWorkflow({
    mode: 'image-to-video',
    prompt: 'Contract.',
    aspectRatio: '16:9',
    duration: 5,
    preset: 'fast',
    seed: 9,
    audio: false,
    inputImageName: 'first.png',
    lastFrameImageName: 'last.png',
    jobId: '../../unsafe id',
  })
  assertWorkflowGraph(workflow)
  assert.equal(workflow['17'].class_type, 'LoadImage')
  assert.deepEqual(workflow['6'].inputs.last_frame, ['17', 0])
  assert.equal(workflow['13'], undefined)
  assert.equal(workflow['4'], undefined)
  assert.equal(workflow['14'].inputs.audio, undefined)
  assert.ok(!workflow['15'].inputs.filename_prefix.includes('..'))
  assert.ok(!workflow['15'].inputs.filename_prefix.includes(' '))
})

test('rejects unsupported or incomplete workflow requests', async () => {
  await assert.rejects(
    buildVideoWorkflow({
      mode: 'image-to-video', prompt: 'Missing frame.', aspectRatio: '16:9', duration: 5,
      preset: 'fast', seed: 1, audio: true, jobId: 'missing-image',
    }),
    /requires an uploaded first frame/,
  )
  await assert.rejects(
    buildVideoWorkflow({
      mode: 'unknown', prompt: 'Unknown.', aspectRatio: '16:9', duration: 5,
      preset: 'fast', seed: 1, audio: true, jobId: 'unknown',
    }),
    /Unsupported video mode/,
  )
})

test('catalog exposes the same workflow contract as the builder', () => {
  const catalog = workflowCatalog()
  assert.equal(catalog.version, WORKFLOW_VERSION)
  assert.deepEqual(catalog.aspectRatios.map(({ id }) => id), Object.keys(VIDEO_DIMENSIONS))
  assert.deepEqual(catalog.durations.map(({ seconds }) => seconds), Object.keys(VIDEO_DURATIONS).map(Number))
  assert.deepEqual(catalog.presets.map(({ id }) => id), Object.keys(VIDEO_PRESETS))
})
