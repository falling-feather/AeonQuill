import { spawn } from 'node:child_process'
import { createRestrictedChildEnvironment } from './security.mjs'

export const VIDEO_FINALIZER_VERSION = 'aeonquill-final-cut-v1'

const JOB_ID_PATTERN = /^(?:video|provider-video)-[a-zA-Z0-9-]{8,120}$/u
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const ALLOWED_KEYS = new Set([
  'sourceJobIds', 'projectId', 'title', 'transitionSeconds', 'width', 'height', 'fps',
])

export class VideoFinalizerError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.name = 'VideoFinalizerError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, status = 400, details = undefined) {
  throw new VideoFinalizerError(code, message, status, details)
}

function finiteNumber(value, label, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    fail('INVALID_FINAL_CUT_REQUEST', `${label} must be between ${minimum} and ${maximum}`)
  }
  return value
}

export function validateFinalCutRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_FINAL_CUT_REQUEST', 'Final cut request must be an object')
  }
  const unknown = Object.keys(input).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length) fail('INVALID_FINAL_CUT_REQUEST', `Unsupported final cut fields: ${unknown.join(', ')}`)
  if (!Array.isArray(input.sourceJobIds) || input.sourceJobIds.length < 2 || input.sourceJobIds.length > 24) {
    fail('INVALID_FINAL_CUT_REQUEST', 'Final cut requires 2–24 completed source jobs')
  }
  const sourceJobIds = input.sourceJobIds.map((value, index) => {
    if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) {
      fail('INVALID_FINAL_CUT_REQUEST', `sourceJobIds[${index}] is not a managed video job id`)
    }
    return value
  })
  if (new Set(sourceJobIds).size !== sourceJobIds.length) {
    fail('INVALID_FINAL_CUT_REQUEST', 'Final cut source jobs must be unique')
  }
  const projectId = input.projectId === undefined || input.projectId === null || input.projectId === ''
    ? undefined
    : String(input.projectId)
  if (projectId && !PROJECT_ID_PATTERN.test(projectId)) {
    fail('INVALID_FINAL_CUT_REQUEST', 'projectId is not a managed project identifier')
  }
  const title = String(input.title || '光阴砚智能视频成片').trim()
  if (!title || title.length > 120) fail('INVALID_FINAL_CUT_REQUEST', 'title must contain 1–120 characters')
  const transitionSeconds = finiteNumber(
    input.transitionSeconds === undefined ? 0.24 : Number(input.transitionSeconds),
    'transitionSeconds',
    0.05,
    1,
  )
  const width = input.width === undefined ? 1280 : Number(input.width)
  const height = input.height === undefined ? 720 : Number(input.height)
  const fps = input.fps === undefined ? 24 : Number(input.fps)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width !== 1280 || height !== 720) {
    fail('INVALID_FINAL_CUT_REQUEST', 'The managed final cut currently requires 1280×720 output')
  }
  if (!Number.isSafeInteger(fps) || ![24, 25, 30].includes(fps)) {
    fail('INVALID_FINAL_CUT_REQUEST', 'fps must be 24, 25, or 30')
  }
  return { sourceJobIds, projectId, title, transitionSeconds, width, height, fps }
}

function fixed(value) {
  return Number(value).toFixed(3)
}

export function buildFinalCutFilter({ probes, width, height, fps, transitionSeconds }) {
  if (!Array.isArray(probes) || probes.length < 2) fail('INVALID_FINAL_CUT_INPUT', 'At least two media probes are required')
  const filters = []
  const silenceInputByClip = new Map()
  let nextInput = probes.length
  probes.forEach((probe, index) => {
    const duration = finiteNumber(Number(probe.duration), `probes[${index}].duration`, 0.5, 900)
    filters.push(
      `[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${width}:${height},fps=${fps},trim=duration=${fixed(duration)},settb=AVTB,setpts=PTS-STARTPTS[v${index}]`,
    )
    if (probe.hasAudio) {
      filters.push(
        `[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `atrim=duration=${fixed(duration)},asetpts=PTS-STARTPTS[a${index}]`,
      )
    } else {
      silenceInputByClip.set(index, nextInput)
      filters.push(
        `[${nextInput}:a:0]aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `atrim=duration=${fixed(duration)},asetpts=PTS-STARTPTS[a${index}]`,
      )
      nextInput += 1
    }
  })

  let videoLabel = 'v0'
  let audioLabel = 'a0'
  let timelineDuration = Number(probes[0].duration)
  for (let index = 1; index < probes.length; index += 1) {
    const transition = Math.min(transitionSeconds, timelineDuration / 3, Number(probes[index].duration) / 3)
    const offset = timelineDuration - transition
    const nextVideo = `vx${index}`
    const nextAudio = `ax${index}`
    filters.push(
      `[${videoLabel}][v${index}]xfade=transition=fade:duration=${fixed(transition)}:offset=${fixed(offset)}[${nextVideo}]`,
    )
    filters.push(
      `[${audioLabel}][a${index}]acrossfade=d=${fixed(transition)}:c1=tri:c2=tri[${nextAudio}]`,
    )
    videoLabel = nextVideo
    audioLabel = nextAudio
    timelineDuration += Number(probes[index].duration) - transition
  }
  filters.push(`[${videoLabel}]format=yuv420p[vout]`)
  filters.push(`[${audioLabel}]loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.891251[aout]`)
  return {
    filter: filters.join(';'),
    duration: timelineDuration,
    silenceInputByClip,
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
  } else {
    child.kill('SIGKILL')
  }
}

function runCommand(executable, args, { signal, timeoutMs = 60 * 60 * 1_000, onStdout } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) return rejectPromise(signal.reason || Object.assign(new Error('Task was cancelled'), { name: 'AbortError' }))
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: createRestrictedChildEnvironment(),
    })
    const stdout = []
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
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk)
      onStdout?.(chunk.toString('utf8'))
    })
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000) })
    const timer = setTimeout(() => {
      terminate(child)
      settle(rejectPromise, Object.assign(new Error('Final cut process timed out'), { code: 'FINAL_CUT_TIMEOUT' }))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => settle(rejectPromise, error))
    child.once('exit', (code) => {
      if (code === 0) settle(resolvePromise, { stdout: Buffer.concat(stdout).toString('utf8'), stderr })
      else settle(rejectPromise, Object.assign(new Error(`Final cut process exited with code ${code}: ${stderr.slice(-2_000)}`), {
        code: 'FINAL_CUT_EXECUTION_ERROR',
      }))
    })
  })
}

export async function probeVideoAsset(ffprobePath, inputPath, signal) {
  const { stdout } = await runCommand(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels',
    '-of', 'json',
    inputPath,
  ], { signal, timeoutMs: 30_000 })
  let payload
  try { payload = JSON.parse(stdout) } catch { fail('FINAL_CUT_PROBE_FAILED', 'FFprobe returned invalid JSON', 500) }
  const video = payload.streams?.find((stream) => stream.codec_type === 'video')
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio')
  const duration = Number(payload.format?.duration)
  if (!video || !Number.isFinite(duration) || duration < 0.5) {
    fail('FINAL_CUT_SOURCE_INVALID', 'A source job does not contain a valid video stream', 409)
  }
  return {
    duration,
    hasAudio: Boolean(audio),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    videoCodec: String(video.codec_name || ''),
    audioCodec: audio ? String(audio.codec_name || '') : null,
    frameRate: String(video.r_frame_rate || ''),
    sampleRate: audio ? Number(audio.sample_rate || 0) : null,
    channels: audio ? Number(audio.channels || 0) : null,
  }
}

function progressSeconds(buffer) {
  const matches = [...String(buffer).matchAll(/out_time_ms=(\d+)/g)]
  if (!matches.length) return null
  return Number(matches.at(-1)[1]) / 1_000_000
}

export async function renderFinalCut({
  ffmpegPath,
  ffprobePath,
  inputPaths,
  outputPath,
  request,
  signal,
  onProgress,
}) {
  const probes = []
  for (let index = 0; index < inputPaths.length; index += 1) {
    probes.push(await probeVideoAsset(ffprobePath, inputPaths[index], signal))
    onProgress?.({ phase: 'probing', progress: 8 + Math.round(((index + 1) / inputPaths.length) * 12) })
  }
  const graph = buildFinalCutFilter({
    probes,
    width: request.width,
    height: request.height,
    fps: request.fps,
    transitionSeconds: request.transitionSeconds,
  })
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  inputPaths.forEach((inputPath) => args.push('-i', inputPath))
  for (const [clipIndex] of graph.silenceInputByClip) {
    args.push('-f', 'lavfi', '-t', fixed(probes[clipIndex].duration), '-i', 'anullsrc=r=48000:cl=stereo')
  }
  args.push(
    '-filter_complex', graph.filter,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high', '-level', '4.1',
    '-pix_fmt', 'yuv420p', '-r', String(request.fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-shortest',
    '-progress', 'pipe:1', '-nostats',
    outputPath,
  )
  let progressBuffer = ''
  await runCommand(ffmpegPath, args, {
    signal,
    timeoutMs: 60 * 60 * 1_000,
    onStdout(chunk) {
      progressBuffer = `${progressBuffer}${chunk}`.slice(-8_000)
      const seconds = progressSeconds(progressBuffer)
      if (seconds !== null) {
        onProgress?.({
          phase: 'encoding',
          progress: Math.min(94, 24 + Math.round((seconds / Math.max(1, graph.duration)) * 70)),
        })
      }
    },
  })
  const outputProbe = await probeVideoAsset(ffprobePath, outputPath, signal)
  if (outputProbe.width !== request.width || outputProbe.height !== request.height) {
    fail('FINAL_CUT_QA_FAILED', 'Final cut dimensions do not match the managed 720P contract', 500, { outputProbe })
  }
  if (!outputProbe.hasAudio || outputProbe.sampleRate !== 48_000 || outputProbe.channels !== 2) {
    fail('FINAL_CUT_QA_FAILED', 'Final cut audio does not match the AAC 48kHz stereo contract', 500, { outputProbe })
  }
  const allowedDelta = Math.max(1, probes.length * 0.08)
  if (Math.abs(outputProbe.duration - graph.duration) > allowedDelta) {
    fail('FINAL_CUT_QA_FAILED', 'Final cut duration differs from the deterministic timeline', 500, {
      expectedDuration: graph.duration,
      outputDuration: outputProbe.duration,
    })
  }
  return {
    version: VIDEO_FINALIZER_VERSION,
    sourceCount: inputPaths.length,
    transitionSeconds: request.transitionSeconds,
    expectedDuration: graph.duration,
    sourceProbes: probes,
    outputProbe,
  }
}
