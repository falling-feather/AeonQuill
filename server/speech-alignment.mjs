import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

import { assertSoundAlignmentCandidate } from '../src/lib/story/soundAlignment.mjs'
import { createRestrictedChildEnvironment, redactSensitiveText } from './security.mjs'
import { runtimeDirectory } from './runtime-paths.mjs'

export const SPEECH_ALIGNMENT_VERSION = 'aeonquill-speech-align-v1'
export const SPEECH_ALIGNMENT_LIMITS = Object.freeze({
  maxTextLength: 2_000,
  maxLanguageLength: 32,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 32 * 1024,
  probeTimeoutMs: 30_000,
  alignmentTimeoutMs: 10 * 60 * 1_000,
})

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/u
const RUNNER_PATH = fileURLToPath(new URL('./align-speech-runner.py', import.meta.url))
const speechRunnerMaterializationPromises = new Map()

export class SpeechAlignmentError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.name = 'SpeechAlignmentError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, status = 400, details = undefined) {
  throw new SpeechAlignmentError(code, message, status, details)
}

function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof SpeechAlignmentError) return reason
  return new SpeechAlignmentError('SPEECH_ALIGNMENT_CANCELLED', 'Speech alignment was cancelled', 499, {
    reason: reason instanceof Error ? reason.message : reason,
  })
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

function configuredPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value) || value.length > 1_024 || /[\u0000-\u001F\u007F]/u.test(value)) {
    fail('SPEECH_ALIGNMENT_INPUT_INVALID', `${label} must be an absolute configured path`)
  }
  return value
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('SPEECH_ALIGNMENT_INPUT_INVALID', `${label} is invalid`)
  return value
}

function safeText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    fail('SPEECH_ALIGNMENT_INPUT_INVALID', `${label} is invalid`)
  }
  return value
}

function validateLanguage(value) {
  if (typeof value !== 'string' || value.length > SPEECH_ALIGNMENT_LIMITS.maxLanguageLength || !LANGUAGE.test(value)) {
    fail('SPEECH_ALIGNMENT_INPUT_INVALID', 'language is invalid')
  }
  return value
}

function validateDuration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1_000) {
    fail('SPEECH_ALIGNMENT_INPUT_INVALID', 'durationMs must be a positive bounded integer')
  }
  return value
}

async function existingPath(path, label, type) {
  try {
    const info = await stat(path)
    if (type === 'file' && !info.isFile()) return `${label} is not a file`
    if (type === 'directory' && !info.isDirectory()) return `${label} is not a directory`
    return null
  } catch {
    return `${label} was not found`
  }
}

function isVirtualRunnerPath(path) {
  return Boolean(process.pkg)
    || /(?:^|[\\/])snapshot(?:[\\/])/iu.test(path)
}

export async function resolveSpeechAlignmentRunnerPath({ sourcePath = RUNNER_PATH, runtimeRoot = runtimeDirectory, packaged = false } = {}) {
  if (!packaged && !isVirtualRunnerPath(sourcePath)) return sourcePath
  const cacheKey = `${sourcePath}\u0000${runtimeRoot}\u0000${packaged ? 'packaged' : 'virtual'}`
  const existingPromise = speechRunnerMaterializationPromises.get(cacheKey)
  if (existingPromise) return existingPromise
  const materializationPromise = (async () => {
    const source = await readFile(sourcePath)
    const digest = createHash('sha256').update(source).digest('hex')
    const targetDirectory = join(runtimeRoot, 'tools', 'speech-alignment', 'runner-cache')
    const target = join(targetDirectory, `align-speech-runner-${digest}.py`)
    await mkdir(targetDirectory, { recursive: true })
    try {
      if ((await readFile(target)).equals(source)) return target
    } catch {
      // The content-addressed runtime copy is absent or stale.
    }
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, source, { mode: 0o600 })
    await rm(target, { force: true })
    await rename(temporary, target)
    return target
  })().catch((error) => {
    speechRunnerMaterializationPromises.delete(cacheKey)
    throw error
  })
  speechRunnerMaterializationPromises.set(cacheKey, materializationPromise)
  return materializationPromise
}

function unavailable(reason, details = undefined) {
  return {
    available: false,
    code: 'SPEECH_ALIGNMENT_UNAVAILABLE',
    reason,
    ...(details ? { details } : {}),
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

async function runRunner(args, { input = '', signal, timeoutMs, ffmpegPath = null }) {
  const runnerPath = await resolveSpeechAlignmentRunnerPath()
  return new Promise((resolvePromise, rejectPromise) => {
    assertNotAborted(signal)
    const childEnvironment = createRestrictedChildEnvironment({
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_DATASETS_OFFLINE: '1',
    })
    if (ffmpegPath) {
      childEnvironment.PATH = [dirname(ffmpegPath), ...String(childEnvironment.PATH || '').split(delimiter).filter(Boolean)].join(delimiter)
    }
    const child = spawn(args[0], [runnerPath, ...args.slice(1)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnvironment,
    })
    const stdout = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    let timer = null
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      terminate(child)
      settle(rejectPromise, abortError(signal))
    }
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > SPEECH_ALIGNMENT_LIMITS.maxStdoutBytes) {
        terminate(child)
        settle(rejectPromise, new SpeechAlignmentError('SPEECH_ALIGNMENT_OUTPUT_LIMIT', 'Speech alignment output exceeded the limit', 500))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-SPEECH_ALIGNMENT_LIMITS.maxStderrBytes)
    })
    timer = setTimeout(() => {
      terminate(child)
      settle(rejectPromise, new SpeechAlignmentError('SPEECH_ALIGNMENT_TIMEOUT', 'Speech alignment process timed out', 504))
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => settle(rejectPromise, new SpeechAlignmentError(
      'SPEECH_ALIGNMENT_EXECUTION_ERROR',
      redactSensitiveText(error.message),
      500,
    )))
    child.once('exit', (code, exitSignal) => {
      if (settled) return
      if (code === 0) {
        settle(resolvePromise, { stdout: Buffer.concat(stdout).toString('utf8'), stderr })
        return
      }
      const safeStderr = redactSensitiveText(stderr.slice(-2_000))
      if (/(?:ModuleNotFoundError|No module named ['"]?whisperx|SPEECH_ALIGNMENT_UNAVAILABLE|offline local model)/iu.test(stderr)) {
        settle(rejectPromise, new SpeechAlignmentError('SPEECH_ALIGNMENT_UNAVAILABLE', 'Local WhisperX dependencies or model are unavailable', 503, { stderr: safeStderr }))
        return
      }
      settle(rejectPromise, new SpeechAlignmentError(
        'SPEECH_ALIGNMENT_EXECUTION_ERROR',
        `Speech alignment process exited unsuccessfully${exitSignal ? ` (${exitSignal})` : ` (code ${code})`}`,
        500,
        { stderr: safeStderr },
      ))
    })
    child.stdin.once('error', () => {})
    child.stdin.end(input)
  })
}

function parseRunnerJson(stdout) {
  try {
    const value = JSON.parse(stdout)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    fail('SPEECH_ALIGNMENT_PROTOCOL_ERROR', 'Speech alignment runner returned invalid JSON', 500)
  }
}

async function ensureConfigured({ pythonPath, modelDirectory, inputPath = null, ffmpegPath = null }) {
  const paths = [
    await existingPath(pythonPath, 'pythonPath', 'file'),
    await existingPath(modelDirectory, 'modelDirectory', 'directory'),
    ...(inputPath ? [await existingPath(inputPath, 'inputPath', 'file')] : []),
    ...(ffmpegPath ? [await existingPath(ffmpegPath, 'ffmpegPath', 'file')] : []),
  ]
  const firstMissing = paths.find(Boolean)
  if (firstMissing) return firstMissing
  return null
}

export async function probeSpeechAlignment({ pythonPath, modelDirectory, ffmpegPath, signal } = {}) {
  assertNotAborted(signal)
  let configuredPythonPath
  let configuredModelDirectory
  let configuredFfmpegPath
  try {
    configuredPythonPath = configuredPath(pythonPath, 'pythonPath')
    configuredModelDirectory = configuredPath(modelDirectory, 'modelDirectory')
  } catch (error) {
    if (error instanceof SpeechAlignmentError && error.code === 'SPEECH_ALIGNMENT_INPUT_INVALID') return unavailable(error.message)
    throw error
  }
  const missing = await ensureConfigured({ pythonPath: configuredPythonPath, modelDirectory: configuredModelDirectory })
  if (missing) return unavailable(missing)
  try {
    configuredFfmpegPath = configuredPath(ffmpegPath, 'ffmpegPath')
  } catch (error) {
    if (error instanceof SpeechAlignmentError && error.code === 'SPEECH_ALIGNMENT_INPUT_INVALID') return unavailable(error.message)
    throw error
  }
  const configuredMissing = await ensureConfigured({
    pythonPath: configuredPythonPath,
    modelDirectory: configuredModelDirectory,
    ffmpegPath: configuredFfmpegPath,
  })
  if (configuredMissing) return unavailable(configuredMissing)
  try {
    const result = await runRunner([
      configuredPythonPath,
      '--probe',
      '--model-directory',
      configuredModelDirectory,
      '--ffmpeg-path',
      configuredFfmpegPath,
    ], { signal, timeoutMs: SPEECH_ALIGNMENT_LIMITS.probeTimeoutMs, ffmpegPath: configuredFfmpegPath })
    const payload = parseRunnerJson(result.stdout)
    if (payload.available !== true) return unavailable('WhisperX is not available in the configured offline environment')
    return {
      available: true,
      version: SPEECH_ALIGNMENT_VERSION,
      pythonVersion: typeof payload.pythonVersion === 'string' ? payload.pythonVersion : undefined,
      whisperxVersion: typeof payload.whisperxVersion === 'string' ? payload.whisperxVersion : undefined,
      device: payload.device === 'cpu' ? 'cpu' : undefined,
      model: payload.model && typeof payload.model === 'object' ? payload.model : undefined,
      ffmpegPath: configuredFfmpegPath,
    }
  } catch (error) {
    if (error instanceof SpeechAlignmentError && error.code === 'SPEECH_ALIGNMENT_CANCELLED') throw error
    if (error instanceof SpeechAlignmentError && error.code === 'SPEECH_ALIGNMENT_UNAVAILABLE') return unavailable('WhisperX dependencies or local model are unavailable', error.details)
    return unavailable(error instanceof Error ? error.message : 'WhisperX probe failed')
  }
}

export async function alignSpeech({
  pythonPath,
  modelDirectory,
  inputPath,
  ffmpegPath,
  text,
  language,
  durationMs,
  cueId,
  cueFingerprint,
  audioContentHash,
  signal,
} = {}) {
  assertNotAborted(signal)
  const configuredPythonPath = configuredPath(pythonPath, 'pythonPath')
  const configuredModelDirectory = configuredPath(modelDirectory, 'modelDirectory')
  const configuredInputPath = configuredPath(inputPath, 'inputPath')
  const configuredFfmpegPath = configuredPath(ffmpegPath, 'ffmpegPath')
  const knownText = safeText(text, 'text', SPEECH_ALIGNMENT_LIMITS.maxTextLength)
  const controlledLanguage = validateLanguage(language)
  const actualDurationMs = validateDuration(durationMs)
  const controlledCueId = identifier(cueId, 'cueId')
  const controlledFingerprint = identifier(cueFingerprint, 'cueFingerprint')
  if (typeof audioContentHash !== 'string' || !SHA256.test(audioContentHash)) fail('SPEECH_ALIGNMENT_INPUT_INVALID', 'audioContentHash must be a lowercase SHA-256')
  const missing = await ensureConfigured({
    pythonPath: configuredPythonPath,
    modelDirectory: configuredModelDirectory,
    inputPath: configuredInputPath,
    ffmpegPath: configuredFfmpegPath,
  })
  if (missing) fail('SPEECH_ALIGNMENT_UNAVAILABLE', missing, 503)
  const result = await runRunner([
    configuredPythonPath,
    '--align',
    '--model-directory',
    configuredModelDirectory,
    '--ffmpeg-path',
    configuredFfmpegPath,
  ], {
    input: JSON.stringify({
      inputPath: configuredInputPath,
      text: knownText,
      language: controlledLanguage,
      durationMs: actualDurationMs,
      cueId: controlledCueId,
      cueFingerprint: controlledFingerprint,
      audioContentHash,
    }),
    signal,
    ffmpegPath: configuredFfmpegPath,
    timeoutMs: SPEECH_ALIGNMENT_LIMITS.alignmentTimeoutMs,
  })
  const candidate = parseRunnerJson(result.stdout)
  try {
    const validated = assertSoundAlignmentCandidate(candidate, { durationMs: actualDurationMs })
    if (validated.cueId !== controlledCueId || validated.cueFingerprint !== controlledFingerprint || validated.audioContentHash !== audioContentHash || validated.language !== controlledLanguage || validated.source !== 'whisperx') {
      fail('SPEECH_ALIGNMENT_PROTOCOL_ERROR', 'Speech alignment runner returned a mismatched candidate identity', 500)
    }
    return validated
  } catch (error) {
    if (error instanceof SpeechAlignmentError) throw error
    throw new SpeechAlignmentError('SPEECH_ALIGNMENT_PROTOCOL_ERROR', 'Speech alignment candidate failed validation', 500, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}
