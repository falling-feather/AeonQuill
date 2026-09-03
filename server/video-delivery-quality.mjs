import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRestrictedChildEnvironment } from './security.mjs'

export const VIDEO_DELIVERY_QUALITY_SCHEMA_VERSION = 1
export const VIDEO_DELIVERY_QUALITY_PROFILE_VERSION = 'aeonquill-720p-delivery-v1'

const MAX_MEDIA_BYTES = 20 * 1024 ** 3
const MAX_SUBTITLE_BYTES = 2 * 1024 ** 2
const EXPECTED_KEYS = new Set([
  'width', 'height', 'fps', 'durationSeconds', 'durationToleranceSeconds',
  'minDurationSeconds', 'maxDurationSeconds', 'requireAudio', 'subtitleExpected',
])

export class VideoDeliveryQualityError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.name = 'VideoDeliveryQualityError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, status = 400, details = undefined) {
  throw new VideoDeliveryQualityError(code, message, status, details)
}

function finite(value, label, minimum, maximum) {
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || normalized < minimum || normalized > maximum) {
    fail('INVALID_VIDEO_QUALITY_EXPECTATION', `${label} must be between ${minimum} and ${maximum}`)
  }
  return normalized
}

export function normalizeVideoDeliveryExpectation(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_VIDEO_QUALITY_EXPECTATION', 'Video quality expectation must be an object')
  }
  const unknown = Object.keys(input).filter((key) => !EXPECTED_KEYS.has(key))
  if (unknown.length) fail('INVALID_VIDEO_QUALITY_EXPECTATION', `Unsupported expectation fields: ${unknown.join(', ')}`)
  const width = finite(input.width ?? 1280, 'width', 16, 8_192)
  const height = finite(input.height ?? 720, 'height', 16, 8_192)
  const fps = finite(input.fps ?? 24, 'fps', 1, 240)
  if (![width, height].every(Number.isSafeInteger)) {
    fail('INVALID_VIDEO_QUALITY_EXPECTATION', 'width and height must be integers')
  }
  const durationSeconds = input.durationSeconds === undefined
    ? null
    : finite(input.durationSeconds, 'durationSeconds', 0.5, 14_400)
  const durationToleranceSeconds = input.durationToleranceSeconds === undefined
    ? Math.max(0.5, (durationSeconds || 0) * 0.02)
    : finite(input.durationToleranceSeconds, 'durationToleranceSeconds', 0.05, 60)
  const minDurationSeconds = input.minDurationSeconds === undefined
    ? null
    : finite(input.minDurationSeconds, 'minDurationSeconds', 0.5, 14_400)
  const maxDurationSeconds = input.maxDurationSeconds === undefined
    ? null
    : finite(input.maxDurationSeconds, 'maxDurationSeconds', 0.5, 14_400)
  if (minDurationSeconds !== null && maxDurationSeconds !== null && minDurationSeconds > maxDurationSeconds) {
    fail('INVALID_VIDEO_QUALITY_EXPECTATION', 'minDurationSeconds cannot exceed maxDurationSeconds')
  }
  return {
    width,
    height,
    fps,
    durationSeconds,
    durationToleranceSeconds,
    minDurationSeconds,
    maxDurationSeconds,
    requireAudio: input.requireAudio !== false,
    subtitleExpected: input.subtitleExpected === true,
  }
}

function splitAssFields(value, count) {
  const fields = []
  let remainder = value
  for (let index = 0; index < count - 1; index += 1) {
    const comma = remainder.indexOf(',')
    if (comma < 0) return null
    fields.push(remainder.slice(0, comma).trim())
    remainder = remainder.slice(comma + 1)
  }
  fields.push(remainder.trim())
  return fields
}

function assTimestampSeconds(value) {
  const match = /^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u.exec(String(value).trim())
  if (!match) return null
  const fraction = Number(`0.${match[4] || '0'}`)
  const seconds = Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]) + fraction
  return Number.isFinite(seconds) ? seconds : null
}

function numericField(record, key, fallback = 0) {
  const value = Number(record?.[key])
  return Number.isFinite(value) ? value : fallback
}

export function inspectAssSubtitleText(text, options = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_SUBTITLE_BYTES) {
    fail('INVALID_VIDEO_SUBTITLE', 'ASS subtitle must be UTF-8 text no larger than 2 MiB')
  }
  const expectedWidth = finite(options.width ?? 1280, 'subtitle width', 16, 8_192)
  const expectedHeight = finite(options.height ?? 720, 'subtitle height', 16, 8_192)
  const durationSeconds = finite(options.durationSeconds ?? 14_400, 'subtitle duration', 0.5, 14_400)
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  let section = ''
  let styleFormat = []
  let eventFormat = []
  const styles = new Map()
  const cues = []
  let playResX = 0
  let playResY = 0

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';')) continue
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase()
      continue
    }
    if (section === 'script info') {
      if (/^PlayResX:/iu.test(line)) playResX = Number(line.split(':', 2)[1].trim())
      if (/^PlayResY:/iu.test(line)) playResY = Number(line.split(':', 2)[1].trim())
      continue
    }
    if (section === 'v4+ styles') {
      if (/^Format:/iu.test(line)) {
        styleFormat = line.slice(line.indexOf(':') + 1).split(',').map((field) => field.trim().toLowerCase())
      } else if (/^Style:/iu.test(line) && styleFormat.length) {
        const values = splitAssFields(line.slice(line.indexOf(':') + 1), styleFormat.length)
        if (!values) continue
        const record = Object.fromEntries(styleFormat.map((field, index) => [field, values[index]]))
        if (record.name) styles.set(record.name, record)
      }
      continue
    }
    if (section === 'events') {
      if (/^Format:/iu.test(line)) {
        eventFormat = line.slice(line.indexOf(':') + 1).split(',').map((field) => field.trim().toLowerCase())
      } else if (/^Dialogue:/iu.test(line) && eventFormat.length) {
        const values = splitAssFields(line.slice(line.indexOf(':') + 1), eventFormat.length)
        if (!values) {
          cues.push({ invalid: true })
          continue
        }
        const record = Object.fromEntries(eventFormat.map((field, index) => [field, values[index]]))
        const style = styles.get(record.style) || styles.get('Default') || null
        const start = assTimestampSeconds(record.start)
        const end = assTimestampSeconds(record.end)
        const marginL = numericField(record, 'marginl') || numericField(style, 'marginl')
        const marginR = numericField(record, 'marginr') || numericField(style, 'marginr')
        const marginV = numericField(record, 'marginv') || numericField(style, 'marginv')
        const position = /\\pos\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*\)/iu.exec(record.text || '')
        cues.push({
          start,
          end,
          marginL,
          marginR,
          marginV,
          position: position ? { x: Number(position[1]), y: Number(position[2]) } : null,
          empty: !String(record.text || '').replace(/\{[^}]*\}/gu, '').replace(/\\N/gu, '').trim(),
        })
      }
    }
  }

  const safeX = expectedWidth * 0.05
  const safeY = expectedHeight * 0.05
  const invalidTiming = cues.filter((cue) => (
    cue.invalid
    || cue.start === null
    || cue.end === null
    || cue.start < 0
    || cue.end <= cue.start
    || cue.end > durationSeconds + 0.25
    || cue.empty
  )).length
  const unsafeMargins = cues.filter((cue) => !cue.invalid && (
    cue.marginL < safeX || cue.marginR < safeX || cue.marginV < safeY
  )).length
  const outsidePositions = cues.filter((cue) => cue.position && (
    !Number.isFinite(cue.position.x)
    || !Number.isFinite(cue.position.y)
    || cue.position.x < safeX
    || cue.position.x > expectedWidth - safeX
    || cue.position.y < safeY
    || cue.position.y > expectedHeight - safeY
  )).length
  const sorted = cues.filter((cue) => cue.start !== null && cue.end !== null).sort((left, right) => left.start - right.start)
  let overlappingCues = 0
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end - 0.02) overlappingCues += 1
  }
  return {
    present: true,
    format: 'ass',
    playResolution: { width: playResX, height: playResY },
    cueCount: cues.length,
    invalidTiming,
    unsafeMargins,
    outsidePositions,
    overlappingCues,
    minimumSafeMargin: { x: Math.round(safeX), y: Math.round(safeY) },
  }
}

function parseNumber(value) {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim().toLowerCase()
  if (normalized === '-inf') return Number.NEGATIVE_INFINITY
  const number = Number(normalized)
  return Number.isFinite(number) ? number : null
}

function parseRate(value) {
  const [numerator, denominator = '1'] = String(value || '').split('/')
  const result = Number(numerator) / Number(denominator)
  return Number.isFinite(result) ? result : 0
}

function intervalSummary(segments, durationSeconds) {
  const bounded = segments
    .map(({ start, end, duration }) => {
      const safeStart = Math.max(0, Number(start) || 0)
      const safeEnd = Math.min(durationSeconds, Number(end) || safeStart + (Number(duration) || 0))
      return { start: safeStart, end: Math.max(safeStart, safeEnd), duration: Math.max(0, safeEnd - safeStart) }
    })
    .filter(({ duration }) => duration > 0)
  return {
    count: bounded.length,
    totalSeconds: bounded.reduce((total, segment) => total + segment.duration, 0),
    longestSeconds: bounded.reduce((longest, segment) => Math.max(longest, segment.duration), 0),
    segments: bounded.slice(0, 24),
  }
}

function parsePairedIntervals(stderr, prefix, durationSeconds) {
  const token = prefix === 'freeze'
    ? /lavfi\.freezedetect\.freeze_(start|duration|end):\s*(-?(?:\d+(?:\.\d+)?|inf))/giu
    : /(silence_start|silence_end|silence_duration):\s*(-?(?:\d+(?:\.\d+)?|inf))/giu
  const segments = []
  let current = null
  for (const match of stderr.matchAll(token)) {
    const kind = match[1].replace(`${prefix}_`, '').replace('silence_', '')
    const value = parseNumber(match[2])
    if (!Number.isFinite(value)) continue
    if (kind === 'start') {
      if (current) segments.push({ ...current, end: durationSeconds })
      current = { start: value }
    } else if (current && kind === 'duration') {
      current.duration = value
    } else if (current && kind === 'end') {
      segments.push({ ...current, end: value })
      current = null
    }
  }
  if (current) segments.push({ ...current, end: durationSeconds })
  return intervalSummary(segments, durationSeconds)
}

export function parseVideoQualityAnalysisLog(stderr, durationSeconds) {
  const black = []
  for (const match of String(stderr).matchAll(/black_start:\s*([0-9.]+)\s+black_end:\s*([0-9.]+)\s+black_duration:\s*([0-9.]+)/giu)) {
    black.push({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) })
  }
  const last = (pattern) => {
    const matches = [...String(stderr).matchAll(pattern)]
    return matches.length ? parseNumber(matches.at(-1)[1]) : null
  }
  return {
    black: intervalSummary(black, durationSeconds),
    freeze: parsePairedIntervals(String(stderr), 'freeze', durationSeconds),
    silence: parsePairedIntervals(String(stderr), 'silence', durationSeconds),
    loudness: {
      integratedLufs: last(/Integrated loudness:\s*I:\s*(-?(?:inf|[0-9.]+))\s*LUFS/giu),
      rangeLu: last(/Loudness range:\s*LRA:\s*(-?(?:inf|[0-9.]+))\s*LU/giu),
      truePeakDbfs: last(/True peak:\s*Peak:\s*(-?(?:inf|[0-9.]+))\s*dBFS/giu),
    },
  }
}

function check(id, label, level, passed, actual, expected, message, applicable = true) {
  return { id, label, level, status: applicable ? (passed ? 'pass' : 'fail') : 'not-applicable', actual, expected, message }
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null
}

export function evaluateVideoDeliveryQuality({ media, asset, signals, subtitles = null, expected: expectedInput = {} }) {
  const expected = normalizeVideoDeliveryExpectation(expectedInput)
  if (!media || typeof media !== 'object' || !asset || typeof asset !== 'object' || !signals || typeof signals !== 'object') {
    fail('INVALID_VIDEO_QUALITY_INPUT', 'Media, asset and signal facts are required')
  }
  if (!/^[a-f0-9]{64}$/u.test(String(asset.sha256 || ''))
    || !Number.isSafeInteger(asset.bytes)
    || asset.bytes <= 0
    || asset.bytes > MAX_MEDIA_BYTES) {
    fail('INVALID_VIDEO_QUALITY_INPUT', 'Asset identity must contain a SHA-256 hash and bounded byte size')
  }
  const duration = finite(media.durationSeconds, 'media.durationSeconds', 0.5, 14_400)
  const frameRate = finite(media.frameRate, 'media.frameRate', 0.1, 240)
  const frames = Number(media.frames)
  const checks = []
  checks.push(check('video.dimensions', '720P 画面尺寸', 'error', media.width === expected.width && media.height === expected.height,
    `${media.width}×${media.height}`, `${expected.width}×${expected.height}`, '最终交付必须使用受管输出尺寸。'))
  checks.push(check('video.frame-rate', '恒定目标帧率', 'error', Math.abs(frameRate - expected.fps) <= 0.02,
    frameRate, expected.fps, '帧率偏离目标会造成时长或播放节奏漂移。'))
  const expectedFrameSeconds = expected.durationSeconds ?? duration
  const expectedFrames = Math.round(expectedFrameSeconds * expected.fps)
  const frameTolerance = Math.max(2, Math.ceil(expected.fps * (
    expected.durationSeconds === null ? 0.1 : expected.durationToleranceSeconds
  )))
  checks.push(check('video.frame-count', '交付帧数', 'error',
    Number.isSafeInteger(frames) && frames > 0 && Math.abs(frames - expectedFrames) <= frameTolerance,
    Number.isSafeInteger(frames) ? frames : null, `${expectedFrames}±${frameTolerance}`,
    '实际解码帧数必须与目标帧率和批准时长一致。'))
  checks.push(check('video.codec', '交付视频编码', 'error', media.videoCodec === 'h264', media.videoCodec, 'h264', '当前 Windows 交付契约固定为 H.264。'))
  checks.push(check('video.pixel-format', '通用像素格式', 'error', media.pixelFormat === 'yuv420p', media.pixelFormat, 'yuv420p', '交付应使用通用 8-bit 4:2:0 像素格式。'))
  if (expected.durationSeconds !== null) {
    checks.push(check('timeline.duration', '确定性成片时长', 'error', Math.abs(duration - expected.durationSeconds) <= expected.durationToleranceSeconds,
      duration, `${expected.durationSeconds}±${expected.durationToleranceSeconds}s`, '成片时长必须与已批准时间线一致。'))
  }
  if (expected.minDurationSeconds !== null) {
    checks.push(check('timeline.minimum-duration', '样片最小时长', 'error', duration >= expected.minDurationSeconds,
      duration, `≥${expected.minDurationSeconds}s`, '固定质量样片必须达到规划中的最小时长。'))
  }
  if (expected.maxDurationSeconds !== null) {
    checks.push(check('timeline.maximum-duration', '样片最大时长', 'error', duration <= expected.maxDurationSeconds,
      duration, `≤${expected.maxDurationSeconds}s`, '样片时长超出当前质量档案边界。'))
  }
  checks.push(check('audio.present', '成片音轨', 'error', Boolean(media.hasAudio), Boolean(media.hasAudio), true,
    '最终声画交付需要有效音轨。', expected.requireAudio))
  checks.push(check('audio.sample-rate', '音频采样率', 'error', media.sampleRate === 48_000,
    media.sampleRate, 48_000, '交付音频固定为 48kHz。', expected.requireAudio && media.hasAudio))
  checks.push(check('audio.channels', '立体声声道', 'error', media.channels === 2,
    media.channels, 2, '交付音频固定为双声道。', expected.requireAudio && media.hasAudio))
  checks.push(check('audio.codec', '交付音频编码', 'error', media.audioCodec === 'aac', media.audioCodec, 'aac',
    'MP4 交付音频固定为 AAC。', expected.requireAudio && media.hasAudio))

  const loudness = signals.loudness || {}
  checks.push(check('audio.integrated-loudness', '综合响度', 'warning',
    Number.isFinite(loudness.integratedLufs) && loudness.integratedLufs >= -16 && loudness.integratedLufs <= -12,
    finiteOrNull(loudness.integratedLufs), '-16…-12 LUFS', '超出建议区间时需要人工试听并决定是否重混。', media.hasAudio))
  checks.push(check('audio.true-peak', 'True Peak', 'warning',
    Number.isFinite(loudness.truePeakDbfs) && loudness.truePeakDbfs <= -1,
    finiteOrNull(loudness.truePeakDbfs), '≤ -1 dBFS', '峰值过高可能在转码或播放端产生削波。', media.hasAudio))

  const interiorBlack = (signals.black?.segments || []).filter(({ start, end }) => start > 0.15 && end < duration - 0.15)
  const interiorBlackSeconds = interiorBlack.reduce((total, segment) => total + segment.duration, 0)
  const blackLimit = Math.max(1, duration * 0.03)
  checks.push(check('picture.interior-black', '非首尾黑帧', 'warning', interiorBlackSeconds <= blackLimit,
    Number(interiorBlackSeconds.toFixed(3)), `≤${Number(blackLimit.toFixed(3))}s`, '较长的片中黑场需要确认不是漏帧或空镜。'))
  const freezeLimit = Math.max(2.5, duration * 0.2)
  checks.push(check('picture.freeze', '长静帧', 'warning', (signals.freeze?.longestSeconds || 0) <= freezeLimit,
    Number((signals.freeze?.longestSeconds || 0).toFixed(3)), `≤${Number(freezeLimit.toFixed(3))}s`, '长静帧可能是生成失败，也可能是有意停顿，必须人工判定。'))
  const silenceLimit = Math.max(3, duration * 0.5)
  checks.push(check('audio.silence', '长静音段', 'warning', (signals.silence?.longestSeconds || 0) <= silenceLimit,
    Number((signals.silence?.longestSeconds || 0).toFixed(3)), `≤${Number(silenceLimit.toFixed(3))}s`, '长静音可能遗漏对白、环境声或配乐。', media.hasAudio))

  checks.push(check('subtitle.present', '字幕交付', 'error', Boolean(subtitles?.present), Boolean(subtitles?.present), true,
    '要求字幕的成片必须携带并烧录受管 ASS。', expected.subtitleExpected))
  if (subtitles?.present) {
    checks.push(check('subtitle.resolution', '字幕坐标系', 'error',
      subtitles.playResolution?.width === expected.width && subtitles.playResolution?.height === expected.height,
      `${subtitles.playResolution?.width || 0}×${subtitles.playResolution?.height || 0}`,
      `${expected.width}×${expected.height}`, 'ASS 坐标系必须与最终画面一致。'))
    checks.push(check('subtitle.cues', '有效字幕时间', 'error', subtitles.cueCount > 0 && subtitles.invalidTiming === 0,
      { cues: subtitles.cueCount, invalid: subtitles.invalidTiming }, '至少 1 条且全部有效', '字幕不得为空、逆序或超出成片时长。'))
    checks.push(check('subtitle.safe-area', '字幕安全区', 'warning', subtitles.unsafeMargins === 0,
      subtitles.unsafeMargins, 0, '低于 5% 安全边距的字幕需要人工检查裁切风险。'))
    checks.push(check('subtitle.position', '字幕定位边界', 'error', subtitles.outsidePositions === 0,
      subtitles.outsidePositions, 0, '显式定位不得落到 5% 安全区之外。'))
    checks.push(check('subtitle.overlap', '字幕时间重叠', 'warning', subtitles.overlappingCues === 0,
      subtitles.overlappingCues, 0, '重叠字幕可能互相遮挡或造成阅读节奏问题。'))
  }

  const blockingCount = checks.filter(({ level, status }) => level === 'error' && status === 'fail').length
  const reviewCount = checks.filter(({ level, status }) => level === 'warning' && status === 'fail').length
  const status = blockingCount ? 'fail' : reviewCount ? 'review' : 'pass'
  return {
    schemaVersion: VIDEO_DELIVERY_QUALITY_SCHEMA_VERSION,
    profileVersion: VIDEO_DELIVERY_QUALITY_PROFILE_VERSION,
    evaluatedAt: Date.now(),
    asset: {
      sha256: String(asset.sha256 || ''),
      bytes: Number(asset.bytes || 0),
    },
    media: {
      width: media.width,
      height: media.height,
      durationSeconds: duration,
      frameRate,
      frames: Number.isSafeInteger(frames) ? frames : 0,
      videoCodec: media.videoCodec,
      pixelFormat: media.pixelFormat,
      bitRate: media.bitRate,
      hasAudio: Boolean(media.hasAudio),
      audioCodec: media.audioCodec,
      sampleRate: media.sampleRate,
      channels: media.channels,
    },
    signals: {
      black: signals.black,
      freeze: signals.freeze,
      silence: signals.silence,
      loudness: {
        integratedLufs: finiteOrNull(loudness.integratedLufs),
        rangeLu: finiteOrNull(loudness.rangeLu),
        truePeakDbfs: finiteOrNull(loudness.truePeakDbfs),
      },
    },
    subtitles: subtitles || { present: false },
    checks,
    summary: {
      status,
      blockingCount,
      reviewCount,
      passedCount: checks.filter(({ status: checkStatus }) => checkStatus === 'pass').length,
      manualReviewRequired: true,
      manualReviewDimensions: ['人物身份与服饰', '运动自然度', '画面伪影', '镜头连续性', '字幕可读性', '声音主观听感'],
      statement: '机器门只验证交付与回归信号，不替代人物一致性、运动自然度或叙事质量的人工盲审。',
    },
  }
}

function terminate(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      env: createRestrictedChildEnvironment(),
    }).unref()
  } else child.kill('SIGKILL')
}

function runCommand(executable, args, { signal, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) return rejectPromise(signal.reason || Object.assign(new Error('Task was cancelled'), { name: 'AbortError' }))
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: createRestrictedChildEnvironment(),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      terminate(child)
      settle(rejectPromise, signal.reason || Object.assign(new Error('Task was cancelled'), { name: 'AbortError' }))
    }
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000) })
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000_000) })
    const timer = setTimeout(() => {
      terminate(child)
      settle(rejectPromise, new VideoDeliveryQualityError('VIDEO_QUALITY_TIMEOUT', 'Video delivery analysis timed out', 500))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', () => settle(rejectPromise, new VideoDeliveryQualityError(
      'VIDEO_QUALITY_EXECUTABLE_UNAVAILABLE',
      'Video delivery analysis executable is unavailable',
      500,
    )))
    child.once('exit', (code) => {
      if (code === 0) settle(resolvePromise, { stdout, stderr })
      else settle(rejectPromise, new VideoDeliveryQualityError(
        'VIDEO_QUALITY_EXECUTION_ERROR',
        'Video delivery analysis did not complete successfully',
        500,
        { exitCode: code },
      ))
    })
  })
}

async function sha256(pathname) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) hash.update(chunk)
  return hash.digest('hex')
}

function parseProbe(stdout) {
  let payload
  try { payload = JSON.parse(stdout) } catch { fail('VIDEO_QUALITY_PROBE_INVALID', 'FFprobe returned invalid JSON', 500) }
  const video = payload.streams?.find((stream) => stream.codec_type === 'video')
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio')
  const durationSeconds = Number(payload.format?.duration)
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds < 0.5) {
    fail('VIDEO_QUALITY_MEDIA_INVALID', 'Media does not contain a valid video stream', 409)
  }
  return {
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    durationSeconds,
    frameRate: parseRate(video.avg_frame_rate || video.r_frame_rate),
    frames: Number(video.nb_read_frames || video.nb_frames || 0),
    videoCodec: String(video.codec_name || ''),
    pixelFormat: String(video.pix_fmt || ''),
    bitRate: Number(payload.format?.bit_rate || 0),
    hasAudio: Boolean(audio),
    audioCodec: audio ? String(audio.codec_name || '') : null,
    sampleRate: audio ? Number(audio.sample_rate || 0) : null,
    channels: audio ? Number(audio.channels || 0) : null,
  }
}

export async function analyzeVideoDeliveryQuality({
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  inputPath,
  subtitlePath,
  expected = {},
  signal,
}) {
  if (typeof inputPath !== 'string' || !inputPath) fail('VIDEO_QUALITY_MEDIA_INVALID', 'A managed input path is required')
  const info = await stat(inputPath).catch(() => null)
  if (!info?.isFile() || info.size <= 0 || info.size > MAX_MEDIA_BYTES) {
    fail('VIDEO_QUALITY_MEDIA_INVALID', 'Media is missing, empty or exceeds the 20 GiB analysis limit', 409)
  }
  const [probeResult, hash] = await Promise.all([
    runCommand(ffprobePath, [
      '-v', 'error', '-count_frames',
      '-show_entries', 'format=duration,bit_rate:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,pix_fmt,sample_rate,channels,nb_frames,nb_read_frames',
      '-of', 'json', inputPath,
    ], { signal, timeoutMs: 60_000 }),
    sha256(inputPath).catch(() => fail('VIDEO_QUALITY_MEDIA_READ_FAILED', 'Media could not be read for quality analysis', 500)),
  ])
  const media = parseProbe(probeResult.stdout)
  const videoFilter = 'blackdetect=d=0.35:pix_th=0.10:pic_th=0.98,freezedetect=n=-50dB:d=1.0'
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', inputPath]
  if (media.hasAudio) {
    args.push(
      '-filter_complex', `[0:v:0]${videoFilter}[vq];[0:a:0]silencedetect=n=-50dB:d=1.25,ebur128=peak=true:framelog=verbose[aq]`,
      '-map', '[vq]', '-map', '[aq]', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null',
    )
  } else {
    args.push('-vf', videoFilter, '-an', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null')
  }
  const analysis = await runCommand(ffmpegPath, args, { signal })
  let subtitles = null
  if (subtitlePath) {
    const subtitleInfo = await stat(subtitlePath).catch(() => null)
    if (!subtitleInfo?.isFile() || subtitleInfo.size <= 0 || subtitleInfo.size > MAX_SUBTITLE_BYTES) {
      fail('INVALID_VIDEO_SUBTITLE', 'Managed ASS subtitle is missing, empty or too large', 409)
    }
    const subtitleText = await readFile(subtitlePath, 'utf8')
      .catch(() => fail('INVALID_VIDEO_SUBTITLE', 'Managed ASS subtitle could not be read', 409))
    subtitles = inspectAssSubtitleText(subtitleText, {
      width: expected.width ?? 1280,
      height: expected.height ?? 720,
      durationSeconds: media.durationSeconds,
    })
  }
  return evaluateVideoDeliveryQuality({
    media,
    asset: { sha256: hash, bytes: info.size },
    signals: parseVideoQualityAnalysisLog(analysis.stderr, media.durationSeconds),
    subtitles,
    expected,
  })
}
