import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateVideoDeliveryQuality,
  inspectAssSubtitleText,
  normalizeVideoDeliveryExpectation,
  parseVideoQualityAnalysisLog,
  VIDEO_DELIVERY_QUALITY_PROFILE_VERSION,
} from '../server/video-delivery-quality.mjs'

function assFixture({ margin = 64, end = '0:00:04.00', text = '以光为墨，以时为卷。' } = {}) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,42,&H00FFFFFF,&H000000FF,&H00141414,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,${margin},${margin},${margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,${end},Default,,0,0,0,,${text}
`
}

function passingInput() {
  return {
    media: {
      width: 1280,
      height: 720,
      durationSeconds: 30,
      frameRate: 24,
      frames: 720,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      bitRate: 5_000_000,
      hasAudio: true,
      audioCodec: 'aac',
      sampleRate: 48_000,
      channels: 2,
    },
    asset: { sha256: 'a'.repeat(64), bytes: 1_000_000 },
    signals: {
      black: { count: 0, totalSeconds: 0, longestSeconds: 0, segments: [] },
      freeze: { count: 0, totalSeconds: 0, longestSeconds: 0, segments: [] },
      silence: { count: 0, totalSeconds: 0, longestSeconds: 0, segments: [] },
      loudness: { integratedLufs: -14, rangeLu: 5, truePeakDbfs: -1.5 },
    },
    subtitles: inspectAssSubtitleText(assFixture(), { width: 1280, height: 720, durationSeconds: 30 }),
    expected: {
      width: 1280,
      height: 720,
      fps: 24,
      durationSeconds: 30,
      minDurationSeconds: 20,
      maxDurationSeconds: 60,
      requireAudio: true,
      subtitleExpected: true,
    },
  }
}

test('normalizes a bounded 720P delivery expectation and rejects hidden policy fields', () => {
  assert.deepEqual(normalizeVideoDeliveryExpectation({ durationSeconds: 30 }), {
    width: 1280,
    height: 720,
    fps: 24,
    durationSeconds: 30,
    durationToleranceSeconds: 0.6,
    minDurationSeconds: null,
    maxDurationSeconds: null,
    requireAudio: true,
    subtitleExpected: false,
  })
  assert.throws(
    () => normalizeVideoDeliveryExpectation({ durationSeconds: 30, inputPath: 'D:/secret.mp4' }),
    (error) => error.code === 'INVALID_VIDEO_QUALITY_EXPECTATION',
  )
  const invalidAsset = passingInput()
  invalidAsset.asset.sha256 = 'D:/secret.mp4'
  assert.throws(
    () => evaluateVideoDeliveryQuality(invalidAsset),
    (error) => error.code === 'INVALID_VIDEO_QUALITY_INPUT' && !error.message.includes('D:/'),
  )
})

test('parses black, freeze, silence and EBU R128 signals without media paths', () => {
  const signals = parseVideoQualityAnalysisLog(`
[blackdetect] black_start:5 black_end:6.25 black_duration:1.25
[freezedetect] lavfi.freezedetect.freeze_start: 8
[freezedetect] lavfi.freezedetect.freeze_duration: 2.5
[freezedetect] lavfi.freezedetect.freeze_end: 10.5
[silencedetect] silence_start: 12
[silencedetect] silence_end: 14.5 | silence_duration: 2.5
Integrated loudness:
  I:         -14.2 LUFS
Loudness range:
  LRA:         4.1 LU
True peak:
  Peak:       -1.4 dBFS
`, 30)
  assert.deepEqual(signals.black.segments, [{ start: 5, end: 6.25, duration: 1.25 }])
  assert.equal(signals.freeze.longestSeconds, 2.5)
  assert.equal(signals.silence.totalSeconds, 2.5)
  assert.deepEqual(signals.loudness, { integratedLufs: -14.2, rangeLu: 4.1, truePeakDbfs: -1.4 })
  assert.equal(JSON.stringify(signals).includes('secret'), false)
})

test('passes structural delivery facts while preserving an explicit human-review boundary', () => {
  const report = evaluateVideoDeliveryQuality(passingInput())
  assert.equal(report.profileVersion, VIDEO_DELIVERY_QUALITY_PROFILE_VERSION)
  assert.equal(report.summary.status, 'pass')
  assert.equal(report.summary.blockingCount, 0)
  assert.equal(report.summary.reviewCount, 0)
  assert.equal(report.summary.manualReviewRequired, true)
  assert.match(report.summary.statement, /不替代/u)
  assert.equal(report.checks.every(({ status }) => status !== 'fail'), true)

  const withoutSubtitles = passingInput()
  withoutSubtitles.subtitles = null
  withoutSubtitles.expected.subtitleExpected = false
  const optionalSubtitleReport = evaluateVideoDeliveryQuality(withoutSubtitles)
  assert.equal(optionalSubtitleReport.checks.find(({ id }) => id === 'subtitle.present')?.status, 'not-applicable')
  assert.equal(optionalSubtitleReport.summary.status, 'pass')
})

test('fails closed on invalid media and marks descriptive anomalies for review', () => {
  const input = passingInput()
  input.media = {
    ...input.media,
    width: 640,
    height: 360,
    frameRate: 23,
    frames: 24,
    videoCodec: 'vp9',
    pixelFormat: 'yuv444p',
    hasAudio: false,
    audioCodec: null,
    sampleRate: null,
    channels: null,
  }
  input.signals.black = { count: 1, totalSeconds: 8, longestSeconds: 8, segments: [{ start: 5, end: 13, duration: 8 }] }
  input.signals.freeze = { count: 1, totalSeconds: 10, longestSeconds: 10, segments: [{ start: 10, end: 20, duration: 10 }] }
  input.subtitles = inspectAssSubtitleText(assFixture({ margin: 8, end: '0:00:40.00', text: '{\\pos(2,2)}越界' }), {
    width: 1280,
    height: 720,
    durationSeconds: 30,
  })
  const report = evaluateVideoDeliveryQuality(input)
  assert.equal(report.summary.status, 'fail')
  assert.ok(report.summary.blockingCount >= 6)
  assert.equal(report.checks.find(({ id }) => id === 'video.frame-count')?.status, 'fail')
  assert.ok(report.summary.reviewCount >= 2)
  assert.equal(report.subtitles.invalidTiming, 1)
  assert.equal(report.subtitles.unsafeMargins, 1)
  assert.equal(report.subtitles.outsidePositions, 1)
})
