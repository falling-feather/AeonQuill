import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { JobStore } from '../server/job-store.mjs'
import { JobScheduler } from '../server/job-scheduler.mjs'
import { SpeechAlignmentJobService } from '../server/speech-alignment-jobs.mjs'

const request = { projectId: 'project-align', documentId: 'document-align', productionRevision: 0, soundTimelineRevision: 0, cueId: 'cue-align', language: 'zh' }
async function setup(callback, overrides = {}) {
  const parent = fileURLToPath(new URL('../.runtime/test-temp/', import.meta.url))
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'alignment-jobs-'))
  const store = new JobStore(join(root, 'jobs.json'))
  await store.load()
  const scheduler = new JobScheduler({ store, resourceLimits: { cpu: 1 } })
  let cue = { id: request.cueId, kind: 'dialogue', text: '仅对齐接口可见的文字', fingerprint: 'cue-input-fingerprint', asset: { contentHash: 'a'.repeat(64) } }
  const service = new SpeechAlignmentJobService({
    rootDirectory: root, store, scheduler, getConfiguration: () => ({}),
    getAuthority: () => ({ timeline: { audioCues: [cue] } }),
    resolveAudio: () => ({ path: join(root, 'managed.wav') }),
    probe: async () => ({ available: true }), probeDuration: async () => 1000,
    align: async (input) => ({ schemaVersion: 1, cueId: input.cueId, cueFingerprint: input.cueFingerprint, audioContentHash: input.audioContentHash, language: input.language, source: 'whisperx', words: [{ text: '仅对齐接口可见的文字', startMs: 100, endMs: 900 }] }),
    ...overrides,
  })
  scheduler.register('speech-alignment', (id, context) => service.execute(id, context))
  try { await callback({ service, store, scheduler, changeCue: (patch) => { cue = { ...cue, ...patch } } }) }
  finally { await scheduler.waitForIdle(); await rm(root, { recursive: true, force: true }) }
}

test('managed alignment queues once, preserves a private result and exposes no transcript in job events', () => setup(async ({ service, store, scheduler }) => {
  const first = await service.create(request, { idempotencyKey: 'align-once' })
  const again = await service.create(request, { idempotencyKey: 'align-once' })
  assert.equal(first.job.id, again.job.id)
  await scheduler.waitForIdle()
  const job = store.get(first.job.id)
  assert.equal(job.status, 'completed')
  assert.equal(job.alignmentMetadata.wordCount, 1)
  assert.ok(!JSON.stringify(store.publicJob(job)).includes('仅对齐接口可见的文字'))
  const result = await service.result(job.id)
  assert.equal(result.durationMs, 1000)
  assert.equal(result.candidate.words[0].text, '仅对齐接口可见的文字')
}))

test('alignment requests reject injected paths and missing tools before creating jobs', () => setup(async ({ service, store }) => {
  await assert.rejects(service.create({ ...request, inputPath: 'D:/private.wav' }), { code: 'SPEECH_ALIGNMENT_REQUEST_INVALID' })
  await assert.rejects(service.create(request), { code: 'SPEECH_ALIGNMENT_UNAVAILABLE' })
  assert.equal(store.list().length, 0)
}, { probe: async () => ({ available: false, reason: '未安装对齐依赖' }) }))

test('changed audio or text invalidates a completed alignment result', () => setup(async ({ service, scheduler, changeCue }) => {
  const { job } = await service.create(request)
  await scheduler.waitForIdle()
  changeCue({ fingerprint: 'changed-input' })
  await assert.rejects(service.result(job.id), { code: 'SPEECH_ALIGNMENT_STALE' })
}))

test('cancelling a queued or running alignment leaves no successful private result', () => setup(async ({ service, scheduler, store }) => {
  const { job } = await service.create(request)
  await scheduler.cancel(job.id)
  await scheduler.waitForIdle()
  assert.equal(store.get(job.id).status, 'cancelled')
  await assert.rejects(service.result(job.id), { code: 'SPEECH_ALIGNMENT_RESULT_UNAVAILABLE' })
}, { align: async ({ signal }) => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason)
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
}) }))
