import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assessSemanticImageQuality,
  evaluateSemanticImageEdit,
  validateSemanticImageQualityManifest,
} from '../server/semantic-image-quality.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const allowIncomplete = process.argv.includes('--allow-incomplete')

function argumentValue(name) {
  const prefix = `--${name}=`
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

function argumentPath(name, fallback) {
  const value = argumentValue(name)
  if (!value) return fallback
  return isAbsolute(value) ? resolve(value) : resolve(projectRoot, value)
}

const manifestPath = argumentPath(
  'manifest',
  join(projectRoot, '.runtime', 'benchmarks', 'semantic-image-quality', 'manifest.json'),
)
const reportPath = argumentPath(
  'output',
  join(projectRoot, '.runtime', 'benchmarks', 'semantic-image-quality', 'latest.json'),
)
const manifestDirectory = dirname(manifestPath)
const decodedCache = new Map()

function portableLabel(pathname) {
  const projectRelative = relative(projectRoot, pathname)
  return !projectRelative.startsWith('..') && !isAbsolute(projectRelative)
    ? projectRelative.replaceAll('\\', '/')
    : basename(pathname)
}

function containedPath(relativePath) {
  const pathname = resolve(manifestDirectory, relativePath)
  const containment = relative(manifestDirectory, pathname)
  if (containment.startsWith('..') || isAbsolute(containment)) {
    throw new Error(`Benchmark path escapes its manifest directory: ${relativePath}`)
  }
  return pathname
}

async function verifyFile(descriptor, label) {
  const pathname = containedPath(descriptor.path)
  const bytes = await readFile(pathname)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== descriptor.sha256) throw new Error(`${label} SHA-256 mismatch: ${descriptor.path}`)
  return pathname
}

function decodeImage(pathname, width, height, pixelFormat, channels) {
  const cacheKey = `${pathname}\0${width}x${height}\0${pixelFormat}`
  if (decodedCache.has(cacheKey)) return decodedCache.get(cacheKey)
  const expectedBytes = width * height * channels
  const promise = new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', pathname,
      '-frames:v', '1', '-an', '-sn', '-dn', '-pix_fmt', pixelFormat,
      '-f', 'rawvideo', 'pipe:1',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let total = 0
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      rejectPromise(new Error(`Timed out decoding ${portableLabel(pathname)}`))
    }, 60_000)
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    child.stdout.on('data', (chunk) => {
      total += chunk.length
      if (total > expectedBytes) {
        child.kill('SIGKILL')
        finish(rejectPromise, new Error(`Dimensions mismatch for ${portableLabel(pathname)}`))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
    child.once('error', (error) => finish(rejectPromise, error))
    child.once('exit', (code) => {
      if (settled) return
      const bytes = Buffer.concat(chunks)
      if (code !== 0 || bytes.length !== expectedBytes) {
        finish(rejectPromise, new Error(
          `Unable to decode ${portableLabel(pathname)} (${bytes.length}/${expectedBytes}): ${stderr.trim()}`,
        ))
        return
      }
      finish(resolvePromise, new Uint8ClampedArray(bytes))
    })
  })
  decodedCache.set(cacheKey, promise)
  return promise
}

const rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const manifest = validateSemanticImageQualityManifest(rawManifest)
const rows = []
for (const sample of manifest.samples) {
  const [sourcePath, outputPath, maskPath] = await Promise.all([
    verifyFile(sample.source, `${sample.id}.source`),
    verifyFile(sample.output, `${sample.id}.output`),
    sample.mask ? verifyFile(sample.mask, `${sample.id}.mask`) : undefined,
  ])
  const [source, output, mask] = await Promise.all([
    decodeImage(sourcePath, sample.width, sample.height, 'rgba', 4),
    decodeImage(outputPath, sample.width, sample.height, 'rgba', 4),
    maskPath ? decodeImage(maskPath, sample.width, sample.height, 'gray', 1) : undefined,
  ])
  rows.push({
    sampleId: sample.id,
    candidateId: sample.candidateId,
    workflowId: sample.workflowId,
    category: sample.category,
    ...evaluateSemanticImageEdit({ source, output, mask, width: sample.width, height: sample.height }),
  })
}

const assessment = assessSemanticImageQuality(manifest, rows)
const report = {
  schemaVersion: 1,
  datasetId: manifest.datasetId,
  sourceManifest: portableLabel(manifestPath),
  generatedAt: new Date().toISOString(),
  status: assessment.gateReady ? 'gate-ready' : 'incomplete',
  environment: manifest.environment,
  thresholds: manifest.thresholds,
  assessment,
  samples: rows,
}
await mkdir(dirname(reportPath), { recursive: true })
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')

for (const [candidateId, result] of Object.entries(assessment.candidates)) {
  console.log(
    `${candidateId}: n=${result.sampleCount}, instruction P50=${result.instruction.p50}, identity P50=${result.identity.p50}, outside-mask MAE P95=${result.outsideMaskMae.p95}, accepted=${result.acceptanceRate}`,
  )
}
console.log(`Report: ${portableLabel(reportPath)}`)
if (!assessment.gateReady) {
  const message = 'AI-001 semantic quality gate remains incomplete: workflow/category coverage or quality thresholds are not met.'
  if (allowIncomplete) console.log(`Smoke only — ${message}`)
  else {
    console.error(message)
    process.exitCode = 1
  }
} else {
  console.log('✓ AI-001 semantic image quality gate is ready for default-policy review')
}
