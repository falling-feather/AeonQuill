import test from 'node:test'
import assert from 'node:assert/strict'

import { compileStoryProject } from '../src/lib/story/storyProject.mjs'
import {
  SoundTimelineError,
  bindSoundAsset,
  createSoundTimeline,
  patchSoundCue,
} from '../src/lib/story/soundTimeline.mjs'
import {
  SoundAlignmentError,
  applySoundAlignment,
  assertSoundAlignmentCandidate,
  previewSoundAlignment,
} from '../src/lib/story/soundAlignment.mjs'

function story() {
  return compileStoryProject({
    projectId: 'alignment-story',
    title: '对齐夹具',
    kind: 'script',
    text: `场景 1：室内·夜
镜头 1：沈砚站在窗前
沈砚：风雪掩住了山门。
镜头 2：沈砚推开山门
沈砚：山门之后没有人。`,
    aspectRatio: '16:9',
    frameStrategy: 'start-end',
    now: 1_000,
  })
}

function candidateFor(timeline, cue = timeline.audioCues.find(({ required }) => required)) {
  return {
    schemaVersion: 1,
    cueId: cue.id,
    cueFingerprint: cue.fingerprint,
    audioContentHash: 'a'.repeat(64),
    language: 'zh-CN',
    source: 'manual',
    words: [
      { text: '风雪', startMs: 90, endMs: 310, confidence: 0.98 },
      { text: '掩住了', startMs: 320, endMs: 620 },
      { text: '山门。', startMs: 630, endMs: 880, confidence: 0.91 },
    ],
  }
}

function withAudio(timeline, cue) {
  return bindSoundAsset(timeline, cue.id, {
    libraryItemId: 'alignment-audio-item',
    libraryVersionId: 'alignment-audio-version',
    contentHash: 'a'.repeat(64),
    mimeType: 'audio/wav',
    scope: 'project',
    boundAt: 1_101,
  }, { now: 1_101 })
}

test('strictly validates relative word timings and rejects unknown or overlapping fields', () => {
  const timeline = createSoundTimeline({ story: story(), now: 1_100 })
  const candidate = candidateFor(timeline)
  assert.deepEqual(assertSoundAlignmentCandidate(candidate, { durationMs: 1_000 }), candidate)
  assert.throws(
    () => assertSoundAlignmentCandidate({ ...candidate, unexpected: true }, { durationMs: 1_000 }),
    (error) => error instanceof SoundAlignmentError && error.code === 'INVALID_FIELDS',
  )
  assert.throws(
    () => assertSoundAlignmentCandidate({ ...candidate, words: [
      { text: '风雪', startMs: 90, endMs: 310 },
      { text: '掩住了', startMs: 300, endMs: 620 },
      { text: '山门。', startMs: 630, endMs: 880 },
    ] }, { durationMs: 1_000 }),
    (error) => error instanceof SoundAlignmentError && error.code === 'WORDS_OVERLAP',
  )
  assert.throws(
    () => assertSoundAlignmentCandidate({ ...candidate, words: candidate.words.map((word) => ({ ...word, endMs: 1_001 })) }, { durationMs: 1_000 }),
    (error) => error instanceof SoundAlignmentError && error.code === 'WORD_OUT_OF_RANGE',
  )
})

test('previews an alignment as an absolute subtitle patch without mutating the timeline', () => {
  const timeline = createSoundTimeline({ story: story(), now: 1_100 })
  const cue = timeline.audioCues.find(({ required }) => required)
  const boundTimeline = withAudio(timeline, cue)
  const subtitle = boundTimeline.subtitleCues.find(({ audioCueId }) => audioCueId === cue.id)
  const candidate = candidateFor(boundTimeline, cue)
  const preview = previewSoundAlignment(boundTimeline, candidate, { durationMs: 1_000 })
  assert.equal(preview.cueId, cue.id)
  assert.equal(preview.subtitleId, subtitle.id)
  assert.deepEqual(preview.patch, {
    startMs: cue.startMs + 90,
    endMs: cue.startMs + 880,
  })
  assert.equal(preview.words[0].startMs, cue.startMs + 90)
  assert.equal(boundTimeline.subtitleCues.find(({ id }) => id === subtitle.id).startMs, subtitle.startMs)
})

test('rejects stale cue text or replaced audio and applies only the linked subtitle after acceptance', () => {
  const timeline = createSoundTimeline({ story: story(), now: 1_100 })
  const cue = timeline.audioCues.find(({ required }) => required)
  const boundTimeline = withAudio(timeline, cue)
  const candidate = candidateFor(boundTimeline, cue)
  assert.throws(
    () => previewSoundAlignment(boundTimeline, { ...candidate, cueFingerprint: 'sound-input-stale' }, { durationMs: 1_000 }),
    (error) => error instanceof SoundAlignmentError && error.code === 'ALIGNMENT_CUE_FINGERPRINT_MISMATCH',
  )
  assert.throws(
    () => previewSoundAlignment(boundTimeline, { ...candidate, audioContentHash: 'b'.repeat(64) }, { durationMs: 1_000 }),
    (error) => error instanceof SoundAlignmentError && error.code === 'ALIGNMENT_AUDIO_HASH_MISMATCH',
  )
  const accepted = applySoundAlignment(boundTimeline, candidate, { durationMs: 1_000, now: 1_102 })
  const linked = accepted.subtitleCues.find(({ audioCueId }) => audioCueId === cue.id)
  const unrelated = accepted.subtitleCues.find(({ audioCueId }) => audioCueId !== cue.id)
  assert.equal(linked.startMs, cue.startMs + 90)
  assert.equal(linked.endMs, cue.startMs + 880)
  assert.equal(linked.status, 'draft')
  assert.equal(unrelated.startMs, boundTimeline.subtitleCues.find(({ id }) => id === unrelated.id).startMs)
})

test('rejects a candidate after the cue text changes even when the old candidate is otherwise valid', () => {
  const timeline = createSoundTimeline({ story: story(), now: 1_100 })
  const cue = timeline.audioCues.find(({ required }) => required)
  const boundTimeline = withAudio(timeline, cue)
  const candidate = candidateFor(boundTimeline, cue)
  const changed = patchSoundCue(boundTimeline, cue.id, { text: '改过的对白。' }, { now: 1_102 })
  assert.throws(
    () => previewSoundAlignment(changed, candidate, { durationMs: 1_000 }),
    (error) => error instanceof SoundAlignmentError && error.code === 'ALIGNMENT_CUE_FINGERPRINT_MISMATCH',
  )
})

test('requires the selected cue to have an immutable approved audio hash', () => {
  const timeline = createSoundTimeline({ story: story(), now: 1_100 })
  const cue = timeline.audioCues.find(({ required }) => required)
  assert.throws(
    () => previewSoundAlignment(timeline, candidateFor(timeline, cue), { durationMs: 1_000 }),
    (error) => error instanceof SoundAlignmentError && error.code === 'ALIGNMENT_AUDIO_NOT_BOUND',
  )
  assert.ok(SoundTimelineError)
})
