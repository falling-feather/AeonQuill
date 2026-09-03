import { mkdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { analyzeVideoDeliveryQuality } from '../server/video-delivery-quality.mjs'

function parseArgs(argv) {
  const options = {}
  for (const token of argv) {
    if (token.startsWith('--label=')) options.label = token.slice(8)
    else if (token.startsWith('--subtitle=')) options.subtitle = token.slice(11)
    else if (token.startsWith('--output=')) options.output = token.slice(9)
    else if (token.startsWith('--fps=')) options.fps = Number(token.slice(6))
    else if (token.startsWith('--min-duration=')) options.minDurationSeconds = Number(token.slice(15))
    else if (token.startsWith('--max-duration=')) options.maxDurationSeconds = Number(token.slice(15))
    else if (token === '--subtitle-expected') options.subtitleExpected = true
    else if (token.startsWith('--')) throw new Error(`Unknown option: ${token}`)
    else if (!options.input) options.input = token
    else throw new Error(`Unexpected input: ${token}`)
  }
  if (!options.input) {
    throw new Error('Usage: npm run audit:video-delivery -- <video.mp4> [--subtitle=file.ass] [--label=name] [--min-duration=20] [--max-duration=60]')
  }
  return options
}

function safeName(value) {
  return String(value).normalize('NFKC').replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'video'
}

const options = parseArgs(process.argv.slice(2))
const inputPath = resolve(options.input)
const outputDirectory = resolve(options.output || '.runtime/benchmarks/video-delivery-quality')
await mkdir(outputDirectory, { recursive: true })
const report = await analyzeVideoDeliveryQuality({
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  inputPath,
  subtitlePath: options.subtitle ? resolve(options.subtitle) : undefined,
  expected: {
    width: 1280,
    height: 720,
    fps: options.fps || 24,
    ...(Number.isFinite(options.minDurationSeconds) ? { minDurationSeconds: options.minDurationSeconds } : {}),
    ...(Number.isFinite(options.maxDurationSeconds) ? { maxDurationSeconds: options.maxDurationSeconds } : {}),
    requireAudio: true,
    subtitleExpected: options.subtitleExpected === true,
  },
})
const label = options.label || basename(inputPath)
const outputPath = resolve(outputDirectory, `${Date.now()}-${safeName(label)}.json`)
await writeFile(outputPath, `${JSON.stringify({ label, sourceFilename: basename(inputPath), report }, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  outputPath,
  label,
  status: report.summary.status,
  sha256: report.asset.sha256,
  media: report.media,
  blockingCount: report.summary.blockingCount,
  reviewCount: report.summary.reviewCount,
  attention: report.checks.filter(({ status }) => status === 'fail').map(({ id, label: checkLabel, level }) => ({ id, label: checkLabel, level })),
}, null, 2))
