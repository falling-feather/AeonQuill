import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  SpeechAlignmentError,
  alignSpeech,
  probeSpeechAlignment,
  resolveSpeechAlignmentRunnerPath,
} from '../server/speech-alignment.mjs'

test('reports unavailable when the configured local model directory is missing', async () => {
  const result = await probeSpeechAlignment({
    pythonPath: 'D:/missing/aeonquill-python.exe',
    modelDirectory: 'D:/missing/whisperx-model',
  })
  assert.equal(result.available, false)
  assert.equal(result.code, 'SPEECH_ALIGNMENT_UNAVAILABLE')
  assert.match(result.reason, /model|python/i)
})

test('reports unavailable when the local adapter has not been configured', async () => {
  const result = await probeSpeechAlignment()
  assert.equal(result.available, false)
  assert.equal(result.code, 'SPEECH_ALIGNMENT_UNAVAILABLE')
})

test('does not start a child process when alignment is already cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    alignSpeech({
      pythonPath: 'D:/missing/aeonquill-python.exe',
      modelDirectory: 'D:/missing/whisperx-model',
      inputPath: 'D:/missing/voice.wav',
      text: '已知文本',
      language: 'zh-CN',
      durationMs: 1_000,
      cueId: 'sound-1',
      cueFingerprint: 'sound-input-1',
      audioContentHash: 'a'.repeat(64),
      signal: controller.signal,
    }),
    (error) => error instanceof SpeechAlignmentError && error.code === 'SPEECH_ALIGNMENT_CANCELLED',
  )
})

test('rejects relative or unbounded adapter inputs before invoking Python', async () => {
  await assert.rejects(
    alignSpeech({
      pythonPath: 'python',
      modelDirectory: 'D:/models/whisperx',
      inputPath: 'voice.wav',
      text: '已知文本',
      language: 'zh-CN',
      durationMs: 1_000,
      cueId: 'sound-1',
      cueFingerprint: 'sound-input-1',
      audioContentHash: 'a'.repeat(64),
    }),
    (error) => error instanceof SpeechAlignmentError && error.code === 'SPEECH_ALIGNMENT_INPUT_INVALID',
  )
})

test('materializes the trusted runner by content hash for packaged sidecar paths', async () => {
  const sourcePath = join(process.cwd(), 'server', 'align-speech-runner.py')
  const runtimeRoot = join(process.cwd(), '.runtime', 'tmp', 'audio-001', 'runner-path-test')
  await rm(runtimeRoot, { recursive: true, force: true })
  await mkdir(runtimeRoot, { recursive: true })
  const source = await readFile(sourcePath)
  const digest = createHash('sha256').update(source).digest('hex')
  const materialized = await resolveSpeechAlignmentRunnerPath({ sourcePath, runtimeRoot, packaged: true })
  assert.match(materialized, new RegExp(`runner-cache[\\\\/]align-speech-runner-${digest}\\.py$`, 'u'))
  assert.deepEqual(await readFile(materialized), source)
  assert.equal(materialized.includes('snapshot'), false)
  await rm(runtimeRoot, { recursive: true, force: true })
})
