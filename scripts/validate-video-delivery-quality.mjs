import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { analyzeVideoDeliveryQuality } from '../server/video-delivery-quality.mjs'

const execFileAsync = promisify(execFile)
const qaRoot = resolve('.runtime', 'qa-temp')
await mkdir(qaRoot, { recursive: true })
const directory = await mkdtemp(join(qaRoot, 'aeonquill-video-delivery-'))
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'

async function ffmpeg(args) {
  await execFileAsync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  })
}

const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,42,&H00FFFFFF,&H000000FF,&H00141414,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,64,64,64,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:03.50,Default,,0,0,0,,Shape Light. Weave Time.
`

try {
  const passingPath = join(directory, 'passing-720p.mp4')
  const subtitlePath = join(directory, 'passing.ass')
  await writeFile(subtitlePath, ass, 'utf8')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '24',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart',
    passingPath,
  ])
  const passing = await analyzeVideoDeliveryQuality({
    ffmpegPath,
    ffprobePath,
    inputPath: passingPath,
    subtitlePath,
    expected: {
      width: 1280,
      height: 720,
      fps: 24,
      durationSeconds: 4,
      durationToleranceSeconds: 0.2,
      requireAudio: true,
      subtitleExpected: true,
    },
  })
  assert.equal(passing.summary.status, 'pass', JSON.stringify(passing.checks.filter(({ status }) => status === 'fail')))
  assert.match(passing.asset.sha256, /^[a-f0-9]{64}$/u)
  assert.equal(JSON.stringify(passing).includes(directory), false)

  const failingPath = join(directory, 'failing-360p.mp4')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=black:size=640x360:rate=12:duration=4',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv444p', '-an', failingPath,
  ])
  const failing = await analyzeVideoDeliveryQuality({
    ffmpegPath,
    ffprobePath,
    inputPath: failingPath,
    expected: {
      width: 1280,
      height: 720,
      fps: 24,
      durationSeconds: 4,
      durationToleranceSeconds: 0.2,
      requireAudio: true,
      subtitleExpected: false,
    },
  })
  assert.equal(failing.summary.status, 'fail')
  assert.ok(failing.summary.blockingCount >= 5)
  assert.equal(failing.checks.find(({ id }) => id === 'picture.freeze')?.status, 'fail')

  const corruptPath = join(directory, 'corrupt.mp4')
  await writeFile(corruptPath, 'not a media container', 'utf8')
  await assert.rejects(
    () => analyzeVideoDeliveryQuality({ ffmpegPath, ffprobePath, inputPath: corruptPath }),
    (error) => error.code === 'VIDEO_QUALITY_EXECUTION_ERROR' && !error.message.includes(directory),
  )
  await assert.rejects(
    () => analyzeVideoDeliveryQuality({ ffmpegPath, ffprobePath, inputPath: join(directory, 'missing.mp4') }),
    (error) => error.code === 'VIDEO_QUALITY_MEDIA_INVALID' && !error.message.includes(directory),
  )
  console.log('✓ VIDEO-011 delivery quality gate passed real FFmpeg positive/negative fixtures without path disclosure')
} finally {
  await rm(directory, { recursive: true, force: true })
}
