import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const execFileAsync = promisify(execFile)

function parseArgs(argv) {
  const options = { inputs: [] }
  for (const token of argv) {
    if (token.startsWith('--ffmpeg=')) options.ffmpeg = token.slice(9)
    else if (token.startsWith('--ffprobe=')) options.ffprobe = token.slice(10)
    else if (token.startsWith('--output=')) options.output = token.slice(9)
    else if (token.startsWith('--label=')) options.label = token.slice(8)
    else if (token.startsWith('--')) throw new Error(`Unknown option: ${token}`)
    else options.inputs.push(token)
  }
  if (options.inputs.length !== 1) throw new Error('Usage: npm run benchmark:video-quality -- <video.mp4> --ffmpeg=<path> --ffprobe=<path> [--label=name]')
  return options
}

function quantile(values, q) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  const fraction = index - lower
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction
}

async function sha256(pathname) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) hash.update(chunk)
  return hash.digest('hex')
}

async function probe(ffprobe, pathname) {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', pathname,
  ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return JSON.parse(stdout)
}

async function blurMetric(ffmpeg, pathname) {
  const { stderr } = await execFileAsync(ffmpeg, [
    '-hide_banner', '-i', pathname,
    '-vf', 'blurdetect=block_width=32:block_height=32:block_pct=80',
    '-an', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null',
  ], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  return Number(/blur mean:\s*([0-9.]+)/i.exec(stderr)?.[1] || NaN)
}

async function temporalMetric(ffmpeg, pathname) {
  const { stdout } = await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', pathname,
    '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YDIF:file=-',
    '-an', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null',
  ], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  const values = [...stdout.matchAll(/lavfi\.signalstats\.YDIF=([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((value, index) => index > 0 && Number.isFinite(value))
  return {
    samples: values.length,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
  }
}

async function contactSheet(ffmpeg, pathname, frameCount, outputPath) {
  const last = Math.max(0, frameCount - 1)
  const middle = Math.round(last / 2)
  const select = `select=eq(n\\,0)+eq(n\\,${middle})+eq(n\\,${last}),scale=640:-2,tile=3x1`
  await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', pathname, '-vf', select, '-frames:v', '1', '-y', outputPath], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const input = resolve(options.inputs[0])
  const ffmpeg = options.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg'
  const ffprobe = options.ffprobe || process.env.FFPROBE_PATH || 'ffprobe'
  const outputDirectory = resolve(options.output || '.runtime/benchmarks/video-quality')
  await mkdir(outputDirectory, { recursive: true })

  const startedAt = new Date().toISOString()
  const [media, hash, blur, temporal] = await Promise.all([
    probe(ffprobe, input),
    sha256(input),
    blurMetric(ffmpeg, input),
    temporalMetric(ffmpeg, input),
  ])
  const video = media.streams.find((stream) => stream.codec_type === 'video')
  const audio = media.streams.find((stream) => stream.codec_type === 'audio')
  const frameCount = Number(video?.nb_read_frames || video?.nb_frames || 0)
  const id = `${Date.now()}-${basename(input).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)}`
  const contactSheetPath = resolve(outputDirectory, `${id}-contact.jpg`)
  await contactSheet(ffmpeg, input, frameCount, contactSheetPath)

  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    label: options.label || basename(input),
    input,
    sha256: hash,
    media: {
      width: video?.width,
      height: video?.height,
      codec: video?.codec_name,
      pixelFormat: video?.pix_fmt,
      frameRate: video?.avg_frame_rate,
      frames: frameCount,
      durationSeconds: Number(media.format?.duration || 0),
      bitRate: Number(media.format?.bit_rate || 0),
      audio: audio ? { codec: audio.codec_name, sampleRate: Number(audio.sample_rate || 0), channels: audio.channels } : null,
      seekable: Boolean(video && Number(media.format?.duration || 0) > 0),
    },
    descriptiveMetrics: {
      ffmpegBlurMean: Number.isFinite(blur) ? blur : null,
      interFrameLumaDifference: temporal,
      warning: 'These are descriptive regression signals, not perceptual quality scores; motion changes YDIF and lower/higher blur values are not universal pass criteria.',
    },
    contactSheet: contactSheetPath,
  }
  const reportPath = resolve(outputDirectory, `${id}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ reportPath, contactSheetPath, media: report.media, metrics: report.descriptiveMetrics }, null, 2))
}

main().catch((error) => {
  console.error(`Video quality benchmark failed: ${error.message}`)
  process.exitCode = 1
})
