import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assessImageQualityCoverage,
  evaluateAlphaMask,
  IMAGE_QUALITY_CATEGORIES,
  IMAGE_QUALITY_METRIC_DIRECTIONS,
  summarizeDistribution,
  validateImageQualityManifest,
} from '../server/image-quality.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const allowIncomplete = process.argv.includes('--allow-incomplete')

function argumentValue(name) {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

function resolvedArgument(name, fallback) {
  const value = argumentValue(name)
  if (!value) return fallback
  return isAbsolute(value) ? resolve(value) : resolve(projectRoot, value)
}

const manifestPath = resolvedArgument(
  'manifest',
  join(projectRoot, '.runtime', 'benchmarks', 'image-quality', 'manifest.json'),
)
const reportPath = resolvedArgument(
  'output',
  join(projectRoot, '.runtime', 'benchmarks', 'image-quality', 'latest.json'),
)
const manifestDirectory = dirname(manifestPath)
const maskCache = new Map()

function portableSourceLabel(pathname) {
  const projectRelative = relative(projectRoot, pathname)
  if (!projectRelative.startsWith('..') && !isAbsolute(projectRelative)) {
    return projectRelative.replaceAll('\\', '/')
  }
  return basename(pathname)
}

function resolveContainedMask(relativePath) {
  const pathname = resolve(manifestDirectory, relativePath)
  const containment = relative(manifestDirectory, pathname)
  if (containment.startsWith('..') || isAbsolute(containment)) {
    throw new Error(`Mask path escapes the benchmark directory: ${relativePath}`)
  }
  return pathname
}

function readGrayscaleMask(pathname, width, height) {
  const cacheKey = `${pathname}\0${width}x${height}`
  if (maskCache.has(cacheKey)) return maskCache.get(cacheKey)
  const expectedBytes = width * height
  const promise = new Promise((resolvePromise, rejectPromise) => {
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
    const child = spawn(ffmpeg, [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      '-i', pathname,
      '-frames:v', '1',
      '-an',
      '-sn',
      '-dn',
      '-vf', 'format=gray',
      '-pix_fmt', 'gray',
      '-f', 'rawvideo',
      'pipe:1',
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks = []
    let byteLength = 0
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
      settled = true
      rejectPromise(new Error(`Timed out while decoding ${portableSourceLabel(pathname)}`))
    }, 60_000)

    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    child.stdout.on('data', (chunk) => {
      byteLength += chunk.length
      if (byteLength > expectedBytes) {
        child.kill('SIGKILL')
        finish(
          rejectPromise,
          new Error(`Mask dimensions do not match the manifest: ${portableSourceLabel(pathname)}`),
        )
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_000)
    })
    child.once('error', (error) => finish(
      rejectPromise,
      new Error(`Unable to start FFmpeg mask decoder: ${error.message}`),
    ))
    child.once('exit', (code) => {
      if (settled) return
      if (code !== 0) {
        finish(
          rejectPromise,
          new Error(`Unable to decode ${portableSourceLabel(pathname)}: ${stderr.trim()}`),
        )
        return
      }
      const bytes = Buffer.concat(chunks)
      if (bytes.length !== expectedBytes) {
        finish(
          rejectPromise,
          new Error(`Mask dimensions do not match the manifest: ${portableSourceLabel(pathname)} (expected ${expectedBytes} bytes, received ${bytes.length})`),
        )
        return
      }
      finish(resolvePromise, new Uint8Array(bytes))
    })
  })
  maskCache.set(cacheKey, promise)
  return promise
}

function roundMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [
    key,
    Number(value.toFixed(6)),
  ]))
}

function aggregateCandidate(candidate, rows) {
  const candidateRows = rows.filter((row) => row.candidateId === candidate.id)
  const metrics = Object.fromEntries(Object.entries(IMAGE_QUALITY_METRIC_DIRECTIONS).map(
    ([metric, direction]) => [
      metric,
      {
        direction,
        ...summarizeDistribution(candidateRows.map((row) => row.metrics[metric])),
      },
    ],
  ))
  return {
    id: candidate.id,
    label: candidate.label,
    ...(candidate.registryId ? { registryId: candidate.registryId } : {}),
    sampleCount: candidateRows.length,
    categories: Object.fromEntries(IMAGE_QUALITY_CATEGORIES.map((category) => [
      category,
      candidateRows.filter((row) => row.category === category).length,
    ])),
    metrics,
    latencyMs: summarizeDistribution(candidateRows.map((row) => row.latencyMs)),
    peakVramMiB: summarizeDistribution(candidateRows.map((row) => row.peakVramMiB)),
    repairSeconds: summarizeDistribution(candidateRows.flatMap((row) => row.repairSeconds)),
  }
}

let rawManifest
try {
  rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error(
      `Image-quality manifest is missing at ${portableSourceLabel(manifestPath)}. Copy benchmarks/image-quality/manifest.example.json and add real masks before running the gate.`,
    )
  }
  throw error
}

const manifest = validateImageQualityManifest(rawManifest)
const rows = []
for (const sample of manifest.samples) {
  const groundTruth = await readGrayscaleMask(
    resolveContainedMask(sample.groundTruthMask),
    sample.width,
    sample.height,
  )
  for (const prediction of sample.predictions) {
    const predictedMask = await readGrayscaleMask(
      resolveContainedMask(prediction.mask),
      sample.width,
      sample.height,
    )
    rows.push({
      sampleId: sample.id,
      category: sample.category,
      candidateId: prediction.candidateId,
      latencyMs: prediction.latencyMs,
      peakVramMiB: prediction.peakVramMiB,
      repairSeconds: prediction.repairSeconds,
      metrics: evaluateAlphaMask({
        prediction: predictedMask,
        groundTruth,
        width: sample.width,
        height: sample.height,
        threshold: manifest.evaluation.threshold,
        boundaryRadius: manifest.evaluation.boundaryRadius,
      }),
    })
  }
}

const coverage = assessImageQualityCoverage(manifest)
const report = {
  schemaVersion: 1,
  datasetId: manifest.datasetId,
  description: manifest.description,
  sourceManifest: portableSourceLabel(manifestPath),
  generatedAt: new Date().toISOString(),
  status: coverage.gateReady ? 'gate-ready' : 'incomplete',
  decoder: 'ffmpeg-gray8',
  evaluation: manifest.evaluation,
  coverage,
  candidates: manifest.candidates.map((candidate) => aggregateCandidate(candidate, rows)),
  samples: rows.map((row) => ({
    ...row,
    metrics: roundMetrics(row.metrics),
  })),
}

await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')

for (const candidate of report.candidates) {
  const alphaMae = candidate.metrics.alphaMae
  const boundaryF1 = candidate.metrics.boundaryF1
  console.log(
    `${candidate.id}: n=${candidate.sampleCount}, alpha MAE P50=${alphaMae.p50}, boundary F1 P50=${boundaryF1.p50}, latency P95=${candidate.latencyMs.p95}ms, repair P50=${candidate.repairSeconds.p50}s`,
  )
}
console.log(`Report: ${portableSourceLabel(reportPath)}`)

if (!coverage.gateReady) {
  const message = 'AI-001 gate remains incomplete: each candidate needs 20 samples in all four categories and repair-time observations.'
  if (allowIncomplete) console.log(`Smoke only — ${message}`)
  else {
    console.error(message)
    process.exitCode = 1
  }
} else {
  console.log('✓ AI-001 image-quality coverage gate is ready for model selection review')
}
