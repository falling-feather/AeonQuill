import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

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
  compileSoundMixPlan,
  renderAssSubtitles,
  renderSoundMix,
  renderSrtSubtitles,
  renderVttSubtitles,
} from '../server/sound-renderer.mjs'
import { renderFinalCut, validateFinalCutRequest } from '../server/video-finalizer.mjs'

const executeFile = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const qaRoot = resolve(projectRoot, '.runtime', 'qa-temp')
await mkdir(qaRoot, { recursive: true })
const directory = await mkdtemp(join(qaRoot, 'aeonquill-sound-render-'))
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'

function binding(index) {
  return {
    libraryItemId: `fixture-item-${index}`,
    libraryVersionId: `fixture-version-${index}`,
    contentHash: index.toString(16).padStart(64, '0'),
    mimeType: 'audio/wav',
    scope: 'project',
    boundAt: 2_000 + index,
  }
}

function approvedTimeline() {
  const story = compileStoryProject({
    projectId: 'sound-render-fixture',
    title: '声音执行夹具',
    kind: 'script',
    text: `场景 1：清晨·庭院
镜头 1：女孩推开窗
旁白：风从院子里吹来。
女孩：今天会是晴天。
镜头 2：树叶在阳光里摇动
音效：一声清脆鸟鸣。`,
    aspectRatio: '16:9',
    frameStrategy: 'start-end',
    now: 1_000,
  })
  let timeline = createSoundTimeline({ story, now: 1_100 })
  timeline.voiceProfiles.forEach((profile, index) => {
    timeline = configureVoiceProfile(timeline, profile.id, {
      providerLabel: 'Fixture TTS', voiceId: `fixture-${index}`, language: 'zh-CN', speed: 1,
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

async function ffmpeg(args) {
  await executeFile(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  })
}

try {
  const plan = compileSoundMixPlan(approvedTimeline())
  const tonePath = join(directory, 'tone.wav')
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-ac', '2', tonePath])
  const mixPath = join(directory, 'mix.wav')
  const mix = await renderSoundMix({
    ffmpegPath,
    ffprobePath,
    inputPaths: plan.cues.map(() => tonePath),
    outputPath: mixPath,
    plan,
  })
  assert.equal(mix.outputProbe.sampleRate, 48_000)
  assert.equal(mix.outputProbe.channels, 2)
  assert(Math.abs(mix.outputProbe.duration - plan.durationMs / 1_000) < 0.08)

  const srtPath = join(directory, 'timeline.srt')
  const vttPath = join(directory, 'timeline.vtt')
  const assPath = join(directory, 'timeline.ass')
  await Promise.all([
    writeFile(srtPath, renderSrtSubtitles(plan), 'utf8'),
    writeFile(vttPath, renderVttSubtitles(plan), 'utf8'),
    writeFile(assPath, renderAssSubtitles(plan), 'utf8'),
  ])

  const clipA = join(directory, 'clip-a.mp4')
  const clipB = join(directory, 'clip-b.mp4')
  const clipDuration = (plan.durationMs / 1_000 + 0.24) / 2
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=0x171421:s=320x180:r=24:d=${clipDuration.toFixed(3)}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipA])
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=0xd19a32:s=320x180:r=24:d=${clipDuration.toFixed(3)}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipB])
  const finalPath = join(directory, 'final.mp4')
  const final = await renderFinalCut({
    ffmpegPath,
    ffprobePath,
    inputPaths: [clipA, clipB],
    outputPath: finalPath,
    request: validateFinalCutRequest({
      sourceJobIds: [
        'video-11111111-1111-4111-8111-111111111111',
        'video-22222222-2222-4222-8222-222222222222',
      ],
      projectId: 'fixture-project',
      title: '声音成片夹具',
      transitionSeconds: 0.24,
      width: 1280,
      height: 720,
      fps: 24,
      soundRenderJobId: 'sound-render-33333333-3333-4333-8333-333333333333',
    }),
    soundMixPath: mixPath,
    subtitlePath: assPath,
  })
  assert.equal(final.soundMix, true)
  assert.equal(final.subtitles, true)
  assert.equal(final.outputProbe.width, 1280)
  assert.equal(final.outputProbe.height, 720)
  assert.equal(final.outputProbe.hasAudio, true)
  assert((await stat(finalPath)).size > 1_000)
  console.log(`✓ Real FFmpeg sound mix, SRT/VTT/ASS sidecars, and subtitle-burned final cut passed (${mix.outputProbe.duration.toFixed(2)}s)`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
