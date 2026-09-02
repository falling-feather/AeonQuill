import test from 'node:test'
import assert from 'node:assert/strict'

import { compileStoryProject } from '../src/lib/story/storyProject.mjs'
import {
  SoundTimelineError,
  approveAllSubtitles,
  approveSoundAsset,
  approveSoundMix,
  approveSubtitleStyle,
  approveVoiceProfile,
  assertSoundTimeline,
  bindSoundAsset,
  configureVoiceProfile,
  createSoundTimeline,
  patchSoundCue,
  patchSoundMix,
  patchSubtitleCue,
  soundTimelineReady,
  soundTimelineSummary,
} from '../src/lib/story/soundTimeline.mjs'

function story(text = `场景 1：雪夜·竹林
镜头 1：沈砚踏雪而来
旁白：风雪掩住了山门。
沈砚：今夜必须查清真相。
音效：远处传来一声剑鸣。
镜头 2：苏晚从桥边现身
苏晚：先收起你的剑。

场景 2：黎明·渡口
镜头 1：二人望向雾中的船
沈砚：我们天亮出发。`) {
  return compileStoryProject({
    projectId: 'sound-story',
    title: '雪夜问剑',
    kind: 'script',
    text,
    aspectRatio: '16:9',
    frameStrategy: 'start-end',
    now: 1_000,
  })
}

function binding(index) {
  return {
    libraryItemId: `audio-item-${index}`,
    libraryVersionId: `audio-version-${index}`,
    contentHash: index.toString(16).padStart(64, '0'),
    mimeType: index % 2 ? 'audio/mpeg' : 'audio/wav',
    scope: index % 2 ? 'project' : 'global-reference',
    boundAt: 2_000 + index,
  }
}

test('compiles dialogue, narration, subtitles, ambience, effects and music into an absolute timeline', () => {
  const graph = createSoundTimeline({ story: story(), now: 1_100 })
  const summary = soundTimelineSummary(graph)
  assert.equal(graph.storyProjectId, 'sound-story')
  assert.equal(graph.durationMs, 15_000)
  assert.equal(graph.voiceProfiles.length, 3)
  assert.equal(graph.audioCues.filter(({ kind }) => kind === 'dialogue').length, 3)
  assert.equal(graph.audioCues.filter(({ kind }) => kind === 'narration').length, 1)
  assert.equal(graph.audioCues.filter(({ kind }) => kind === 'ambience').length, 2)
  assert.equal(graph.audioCues.filter(({ kind }) => kind === 'sfx').length, 1)
  assert.equal(graph.audioCues.filter(({ kind }) => kind === 'music').length, 1)
  assert.equal(graph.subtitleCues.length, 4)
  assert.equal(summary.requiredAudio, 4)
  assert.equal(summary.ready, false)
  assert(graph.audioCues.every(({ startMs, endMs }) => startMs >= 0 && endMs <= graph.durationMs && endMs > startMs))
})

test('binds immutable audio versions and requires explicit approvals for the sound-director gate', () => {
  let graph = createSoundTimeline({ story: story(), now: 1_200 })
  graph.voiceProfiles.forEach((profile, index) => {
    graph = configureVoiceProfile(graph, profile.id, {
      providerLabel: 'OpenAI-compatible',
      voiceId: `voice-${index + 1}`,
      language: 'zh-CN',
      speed: 1,
    }, { now: graph.updatedAt + 1 })
    graph = approveVoiceProfile(graph, profile.id, { now: graph.updatedAt + 1 })
  })
  graph.audioCues.filter(({ required }) => required).forEach((cue, index) => {
    graph = bindSoundAsset(graph, cue.id, binding(index + 1), { now: graph.updatedAt + 1 })
    assert.equal(soundTimelineReady(graph), false)
    graph = approveSoundAsset(graph, cue.id, { now: graph.updatedAt + 1 })
  })
  graph = approveAllSubtitles(graph, { now: graph.updatedAt + 1 })
  graph = approveSubtitleStyle(graph, { now: graph.updatedAt + 1 })
  graph = approveSoundMix(graph, { now: graph.updatedAt + 1 })
  assert.equal(soundTimelineReady(graph), true)
  assert.equal(soundTimelineSummary(graph).approvedRequiredAudio, 4)
})

test('editing speech invalidates its audio and linked subtitle but preserves unrelated cues', () => {
  let graph = createSoundTimeline({ story: story(), now: 1_300 })
  const [first, second] = graph.audioCues.filter(({ required }) => required)
  graph = bindSoundAsset(graph, first.id, binding(1), { now: 1_301 })
  graph = approveSoundAsset(graph, first.id, { now: 1_302 })
  graph = bindSoundAsset(graph, second.id, binding(2), { now: 1_303 })
  graph = approveSoundAsset(graph, second.id, { now: 1_304 })
  graph = approveAllSubtitles(graph, { now: 1_305 })
  const linkedSubtitle = graph.subtitleCues.find(({ audioCueId }) => audioCueId === first.id)

  graph = patchSoundCue(graph, first.id, { text: '改为新的对白。', startMs: first.startMs + 10 }, { now: 1_306 })
  assert.equal(graph.audioCues.find(({ id }) => id === first.id).status, 'planned')
  assert.equal(graph.audioCues.find(({ id }) => id === second.id).status, 'approved')
  assert.equal(graph.subtitleCues.find(({ id }) => id === linkedSubtitle.id).text, '改为新的对白。')
  assert.equal(graph.subtitleCues.find(({ id }) => id === linkedSubtitle.id).status, 'draft')
  assert.equal(graph.subtitleCues.filter(({ status }) => status === 'approved').length, graph.subtitleCues.length - 1)
})

test('subtitle timing and mix edits are bounded, reversible state instead of arbitrary render fields', () => {
  let graph = createSoundTimeline({ story: story(), now: 1_400 })
  const subtitle = graph.subtitleCues[0]
  graph = patchSubtitleCue(graph, subtitle.id, {
    text: '风雪，掩住了山门。',
    startMs: subtitle.startMs + 20,
    endMs: subtitle.endMs - 20,
  }, { now: 1_401 })
  graph = patchSoundMix(graph, { targetLufs: -16, truePeakDbtp: -1.2, dialogueDuckingDb: -10 }, { now: 1_402 })
  assert.equal(graph.subtitleCues[0].text, '风雪，掩住了山门。')
  assert.equal(graph.mix.targetLufs, -16)
  assert.equal(graph.mix.status, 'draft')
  assert.throws(
    () => patchSoundMix(graph, { targetLufs: 2 }, { now: 1_403 }),
    (error) => error instanceof SoundTimelineError && error.code === 'INVALID_NUMBER',
  )
  assert.throws(
    () => patchSubtitleCue(graph, subtitle.id, { startMs: graph.durationMs }, { now: 1_403 }),
    (error) => error instanceof SoundTimelineError && error.code === 'INVALID_INTEGER',
  )
})

test('strict validation rejects path disclosure, forged approvals, collisions and stale fingerprints', () => {
  const graph = createSoundTimeline({ story: story(), now: 1_500 })
  const cue = graph.audioCues.find(({ required }) => required)
  assert.throws(
    () => bindSoundAsset(graph, cue.id, { ...binding(1), localPath: 'D:/private/voice.mp3' }, { now: 1_501 }),
    (error) => error instanceof SoundTimelineError && error.code === 'INVALID_FIELDS',
  )
  const forged = structuredClone(graph)
  forged.audioCues[0].status = 'approved'
  assert.throws(
    () => assertSoundTimeline(forged),
    (error) => error instanceof SoundTimelineError && error.code === 'AUDIO_STATUS_MISMATCH',
  )
  const collision = structuredClone(graph)
  collision.subtitleCues[0].id = collision.audioCues[0].id
  assert.throws(
    () => assertSoundTimeline(collision),
    (error) => error instanceof SoundTimelineError && error.code === 'DUPLICATE_ID',
  )
  const stale = structuredClone(graph)
  stale.audioCues[0].text = '篡改后的对白'
  assert.throws(
    () => assertSoundTimeline(stale),
    (error) => error instanceof SoundTimelineError && error.code === 'AUDIO_FINGERPRINT_MISMATCH',
  )
})

test('story synchronization preserves identical audio assets but reopens timing-dependent approvals', () => {
  const original = story()
  let graph = createSoundTimeline({ story: original, now: 1_600 })
  const speech = graph.audioCues.find(({ required }) => required)
  graph = bindSoundAsset(graph, speech.id, binding(9), { now: 1_601 })
  graph = approveSoundAsset(graph, speech.id, { now: 1_602 })
  graph = approveAllSubtitles(graph, { now: 1_603 })
  graph = approveSubtitleStyle(graph, { now: 1_604 })
  graph = approveSoundMix(graph, { now: 1_605 })

  const revised = story(`${original.source.text}\n\n场景 3：正午·山门\n镜头 1：沈砚推门而入。`)
  revised.revision = original.revision + 1
  revised.updatedAt = 1_700
  const synced = createSoundTimeline({ story: revised, previous: graph, now: 1_701 })
  const preserved = synced.audioCues.find(({ id }) => id === speech.id)
  assert.equal(preserved.asset.contentHash, binding(9).contentHash)
  assert.equal(preserved.status, 'approved')
  assert(synced.subtitleCues.every(({ status }) => status === 'draft'))
  assert.equal(synced.subtitleStyle.status, 'draft')
  assert.equal(synced.mix.status, 'draft')
  assert.equal(synced.storyRevision, revised.revision)
})
