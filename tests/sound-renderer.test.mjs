import test from 'node:test'
import assert from 'node:assert/strict'

import { compileStoryProject } from '../src/lib/story/storyProject.mjs'
import {
  approveAllSubtitles,
  approveSoundAsset,
  approveSoundMix,
  approveSubtitleStyle,
  approveVoiceProfile,
  bindSoundAsset,
  configureVoiceProfile,
  createSoundTimeline,
} from '../src/lib/story/soundTimeline.mjs'
import {
  SOUND_RENDERER_VERSION,
  SoundRendererError,
  assertResolvedSoundAsset,
  buildSoundMixFilter,
  compileSoundMixPlan,
  compileSpeechSynthesisPlan,
  renderAssSubtitles,
  renderSrtSubtitles,
  renderVttSubtitles,
  validateSoundRenderRequest,
} from '../server/sound-renderer.mjs'

function story() {
  return compileStoryProject({
    projectId: 'sound-render-story',
    title: '雨夜归舟',
    kind: 'script',
    text: `场景 1：雨夜·渡口
镜头 1：顾舟撑伞走向渡船
旁白：雨把灯火揉成了金线。
顾舟：开船吧。
镜头 2：船离开码头
音效：木桨划过水面。`,
    aspectRatio: '16:9',
    frameStrategy: 'start-end',
    now: 1_000,
  })
}

function binding(index) {
  return {
    libraryItemId: `sound-item-${index}`,
    libraryVersionId: `sound-version-${index}`,
    contentHash: index.toString(16).padStart(64, '0'),
    mimeType: index % 2 ? 'audio/mpeg' : 'audio/wav',
    scope: 'project',
    boundAt: 2_000 + index,
  }
}

function approvedTimeline() {
  let timeline = createSoundTimeline({ story: story(), now: 1_100 })
  timeline.voiceProfiles.forEach((profile, index) => {
    timeline = configureVoiceProfile(timeline, profile.id, {
      providerLabel: 'OpenAI-compatible',
      voiceId: `voice-${index + 1}`,
      language: 'zh-CN',
      speed: 1,
    }, { now: timeline.updatedAt + 1 })
    timeline = approveVoiceProfile(timeline, profile.id, { now: timeline.updatedAt + 1 })
  })
  timeline.audioCues.forEach((cue, index) => {
    timeline = bindSoundAsset(timeline, cue.id, binding(index + 1), { now: timeline.updatedAt + 1 })
    timeline = approveSoundAsset(timeline, cue.id, { now: timeline.updatedAt + 1 })
  })
  timeline = approveAllSubtitles(timeline, { now: timeline.updatedAt + 1 })
  timeline = approveSubtitleStyle(timeline, { now: timeline.updatedAt + 1 })
  timeline = approveSoundMix(timeline, { now: timeline.updatedAt + 1 })
  return timeline
}

test('validates exact action-specific sound job contracts', () => {
  assert.deepEqual(validateSoundRenderRequest({
    action: 'prepare-speech',
    projectId: 'workspace-project',
    documentId: 'sound-render-story',
    productionRevision: 7,
    soundTimelineRevision: 4,
    title: '对白准备',
    format: 'mp3',
    speechBudgetUsd: 2.5,
  }), {
    action: 'prepare-speech',
    projectId: 'workspace-project',
    documentId: 'sound-render-story',
    productionRevision: 7,
    soundTimelineRevision: 4,
    title: '对白准备',
    format: 'mp3',
    speechBudgetUsd: 2.5,
  })
  assert.throws(
    () => validateSoundRenderRequest({
      action: 'render-mix', projectId: 'workspace-project', documentId: 'sound-render-story',
      productionRevision: 7, soundTimelineRevision: 4, title: '混音', localPath: 'D:/private.wav',
    }),
    (error) => error instanceof SoundRendererError && error.code === 'INVALID_SOUND_RENDER_REQUEST',
  )
})

test('compiles only missing speech against approved voice profiles', () => {
  let timeline = createSoundTimeline({ story: story(), now: 1_200 })
  assert.throws(
    () => compileSpeechSynthesisPlan(timeline),
    (error) => error instanceof SoundRendererError && error.code === 'SOUND_VOICE_NOT_APPROVED',
  )
  timeline.voiceProfiles.forEach((profile, index) => {
    timeline = configureVoiceProfile(timeline, profile.id, {
      providerLabel: 'Fake TTS', voiceId: `speaker-${index}`, language: 'zh-CN', speed: 0.95,
    }, { now: timeline.updatedAt + 1 })
    timeline = approveVoiceProfile(timeline, profile.id, { now: timeline.updatedAt + 1 })
  })
  const firstSpeech = timeline.audioCues.find((cue) => ['dialogue', 'narration'].includes(cue.kind))
  timeline = bindSoundAsset(timeline, firstSpeech.id, binding(1), { now: timeline.updatedAt + 1 })
  const plan = compileSpeechSynthesisPlan(timeline)
  assert.equal(plan.version, SOUND_RENDERER_VERSION)
  assert.equal(plan.cueCount, timeline.audioCues.filter((cue) => ['dialogue', 'narration'].includes(cue.kind)).length - 1)
  assert(plan.cues.every((cue) => cue.voiceId.startsWith('speaker-') && cue.cueFingerprint.startsWith('sound-input-')))
  assert.match(plan.timelineDigest, /^[a-f0-9]{64}$/u)
})

test('approved timeline compiles deterministic mix, subtitle, ducking and style artifacts', () => {
  const plan = compileSoundMixPlan(approvedTimeline())
  const graph = buildSoundMixFilter(plan)
  const srt = renderSrtSubtitles(plan)
  const vtt = renderVttSubtitles(plan)
  const ass = renderAssSubtitles(plan)
  assert.equal(plan.version, SOUND_RENDERER_VERSION)
  assert.equal(plan.cues.length, approvedTimeline().audioCues.length)
  assert.match(graph.filter, /amix=inputs=/u)
  assert.match(graph.filter, /loudnorm=I=-14\.0:TP=-1\.5/u)
  assert.match(graph.filter, /adelay=\d+:all=1/u)
  assert.match(graph.filter, /volume=-9\.0dB:enable='between/u)
  assert.match(srt, /1\n\d{2}:\d{2}:\d{2},\d{3} -->/u)
  assert.match(vtt, /^WEBVTT\n\n/u)
  assert.match(ass, /\[V4\+ Styles\]/u)
  assert.match(ass, /Microsoft YaHei/u)
})

test('mix compilation fails closed until every required approval exists', () => {
  const timeline = createSoundTimeline({ story: story(), now: 1_300 })
  assert.throws(
    () => compileSoundMixPlan(timeline),
    (error) => error instanceof SoundRendererError && error.code === 'SOUND_TIMELINE_NOT_APPROVED',
  )
})

test('resolved library bytes must match the exact approved item, version, hash and media type', () => {
  const approved = binding(5)
  assert.equal(assertResolvedSoundAsset(approved, {
    libraryItemId: approved.libraryItemId,
    libraryVersionId: approved.libraryVersionId,
    contentHash: approved.contentHash,
    mimeType: approved.mimeType,
  }).contentHash, approved.contentHash)
  assert.throws(
    () => assertResolvedSoundAsset(approved, {
      libraryItemId: approved.libraryItemId,
      libraryVersionId: approved.libraryVersionId,
      contentHash: 'f'.repeat(64),
      mimeType: approved.mimeType,
    }),
    (error) => error instanceof SoundRendererError && error.code === 'SOUND_ASSET_HASH_MISMATCH',
  )
})
