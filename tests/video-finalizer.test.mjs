import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFinalCutFilter,
  validateFinalCutRequest,
  VIDEO_FINALIZER_VERSION,
} from '../server/video-finalizer.mjs'

const sourceJobIds = [
  'video-11111111-1111-4111-8111-111111111111',
  'video-22222222-2222-4222-8222-222222222222',
  'provider-video-33333333-3333-4333-8333-333333333333',
]

test('final cut request is a bounded managed-job contract', () => {
  const request = validateFinalCutRequest({
    sourceJobIds,
    projectId: 'wuxia-trial-20260827',
    title: '雪夜问剑',
  })
  assert.equal(VIDEO_FINALIZER_VERSION, 'aeonquill-final-cut-v1')
  assert.deepEqual(request, {
    sourceJobIds,
    projectId: 'wuxia-trial-20260827',
    title: '雪夜问剑',
    transitionSeconds: 0.24,
    width: 1280,
    height: 720,
    fps: 24,
  })
})

test('final cut rejects arbitrary paths, duplicate jobs, and unknown fields', () => {
  assert.throws(
    () => validateFinalCutRequest({ sourceJobIds: ['D:/clip-1.mp4', 'D:/clip-2.mp4'] }),
    (error) => error.code === 'INVALID_FINAL_CUT_REQUEST',
  )
  assert.throws(
    () => validateFinalCutRequest({ sourceJobIds: [sourceJobIds[0], sourceJobIds[0]] }),
    (error) => error.code === 'INVALID_FINAL_CUT_REQUEST',
  )
  assert.throws(
    () => validateFinalCutRequest({ sourceJobIds: sourceJobIds.slice(0, 2), workflowJson: {} }),
    (error) => error.code === 'INVALID_FINAL_CUT_REQUEST',
  )
})

test('final cut graph preserves order, supplies silent audio, and computes deterministic duration', () => {
  const graph = buildFinalCutFilter({
    probes: [
      { duration: 5, hasAudio: true },
      { duration: 5.04, hasAudio: false },
      { duration: 4.96, hasAudio: true },
    ],
    width: 1280,
    height: 720,
    fps: 24,
    transitionSeconds: 0.24,
  })
  assert.match(graph.filter, /\[0:v:0\].*scale=1280:720.*\[v0\]/)
  assert.match(graph.filter, /\[3:a:0\].*\[a1\]/)
  assert.match(graph.filter, /\[v0\]\[v1\]xfade=.*offset=4\.760\[vx1\]/)
  assert.match(graph.filter, /\[vx1\]\[v2\]xfade=.*offset=9\.560\[vx2\]/)
  assert.match(graph.filter, /loudnorm=I=-14:TP=-1\.5:LRA=11/)
  assert.equal(Number(graph.duration.toFixed(3)), 14.52)
  assert.equal(graph.silenceInputByClip.get(1), 3)
})
