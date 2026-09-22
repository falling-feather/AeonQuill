import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { alignSpeech, probeSpeechAlignment } from './speech-alignment.mjs'
import { probeAudioAsset } from './sound-renderer.mjs'
import { createScheduling, createEstimateCostEvent } from './job-scheduler.mjs'
import { assertSoundAlignmentCandidate } from '../src/lib/story/soundAlignment.mjs'
import { redactSensitiveText } from './security.mjs'

const FIELDS = ['projectId', 'documentId', 'productionRevision', 'soundTimelineRevision', 'cueId', 'language']
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/u
const MAX_RESULT_BYTES = 512 * 1024
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
function fail(code, message, status = 400) { throw Object.assign(new Error(message), { code, status }) }

export function validateSpeechAlignmentJobRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !FIELDS.includes(key)) || FIELDS.some((key) => !Object.hasOwn(input, key))) {
    fail('SPEECH_ALIGNMENT_REQUEST_INVALID', '对齐请求字段无效')
  }
  for (const key of ['projectId', 'documentId', 'cueId']) {
    if (typeof input[key] !== 'string' || !ID.test(input[key])) fail('SPEECH_ALIGNMENT_REQUEST_INVALID', `${key} 无效`)
  }
  for (const key of ['productionRevision', 'soundTimelineRevision']) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) fail('SPEECH_ALIGNMENT_REQUEST_INVALID', `${key} 无效`)
  }
  if (typeof input.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(input.language)) fail('SPEECH_ALIGNMENT_REQUEST_INVALID', '请选择支持的语音语言')
  return Object.fromEntries(FIELDS.map((key) => [key, input[key]]))
}

export class SpeechAlignmentJobService {
  constructor({ rootDirectory, store, scheduler, getAuthority, resolveAudio, getConfiguration,
    align = alignSpeech, probe = probeSpeechAlignment, probeDuration } = {}) {
    this.rootDirectory = resolve(rootDirectory)
    Object.assign(this, { store, scheduler, getAuthority, resolveAudio, getConfiguration, align, probe })
    this.probeDuration = probeDuration ?? (async (path, signal, config) => Math.round((await probeAudioAsset(config.ffprobePath, path, signal)).duration * 1000))
  }

  cue(request, expected) {
    const { timeline } = this.getAuthority(request, { requireProductionRevision: !expected, requireSoundTimelineRevision: !expected })
    const cue = timeline.audioCues.find(({ id }) => id === request.cueId)
    if (!cue || !['dialogue', 'narration'].includes(cue.kind) || !cue.asset || !cue.text?.trim()) {
      fail('SPEECH_ALIGNMENT_CUE_UNAVAILABLE', '请选择已绑定音频并包含文字的对白或旁白', 409)
    }
    if (expected && (cue.fingerprint !== expected.cueFingerprint || cue.asset.contentHash !== expected.audioContentHash)) {
      fail('SPEECH_ALIGNMENT_STALE', '对白文字或音频已变化，请重新对齐', 409)
    }
    return cue
  }

  async create(input, options = {}) {
    const request = validateSpeechAlignmentJobRequest(input)
    const cue = this.cue(request)
    const identity = { cueFingerprint: cue.fingerprint, audioContentHash: cue.asset.contentHash }
    const requestHash = sha256(JSON.stringify({ request, ...identity }))
    const idempotencyKey = options.idempotencyKey ?? `speech-alignment-${randomUUID()}`
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length > 160 || !idempotencyKey.trim()) fail('SPEECH_ALIGNMENT_REQUEST_INVALID', '幂等键无效')
    const existing = this.store.findByIdempotencyKey(idempotencyKey)
    if (existing) {
      if (existing.kind !== 'speech-alignment' || existing.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT', '幂等键已绑定不同请求', 409)
      return { job: this.store.publicJob(existing), reused: true }
    }
    const configuration = this.getConfiguration()
    const readiness = await this.probe(configuration)
    if (!readiness.available) fail('SPEECH_ALIGNMENT_UNAVAILABLE', readiness.reason || '本机对齐工具尚未配置', 409)
    this.cue(request, identity)
    const now = Date.now()
    const id = `speech-alignment-${randomUUID()}`
    const job = {
      id, kind: 'speech-alignment', tool: 'speech-alignment', label: '对白强制对齐',
      status: 'queued', phase: 'queued', progress: 0, detail: '等待本地对齐执行器',
      createdAt: now, updatedAt: now, request, requestHash, sourceElementId: request.projectId,
      retryOf: options.retryOf,
      workflowVersion: 'aeonquill-speech-alignment-v1', alignmentMetadata: { ...identity, cueId: request.cueId, language: request.language },
      scheduling: createScheduling({ resourceClass: 'cpu', priority: options.priority ?? 45, timeoutMs: 10 * 60_000, idempotencyKey, queuedAt: now, attempt: options.attempt || 1 }),
      costEvents: [createEstimateCostEvent(id, 'cpu', 60_000, now)],
      logs: [{ at: now, level: 'info', message: '本地对齐任务已创建；字幕仍需明确应用。' }],
    }
    const added = await this.store.addIdempotent(job)
    if (added.created) await this.scheduler.enqueue(id)
    return { job: this.store.publicJob(this.store.get(added.job.id)), reused: !added.created }
  }

  async execute(id, { signal }) {
    const job = this.store.get(id)
    if (!job || job.kind !== 'speech-alignment') return
    const output = join(this.rootDirectory, `${id}.json`)
    const temporary = `${output}.${randomUUID()}.tmp`
    let published = false
    try {
      if (signal.aborted) throw signal.reason
      const cue = this.cue(job.request, job.alignmentMetadata)
      const resolved = this.resolveAudio(job.request.projectId, cue)
      const configuration = this.getConfiguration()
      const durationMs = await this.probeDuration(resolved.path, signal, configuration)
      await this.store.update(id, { phase: 'aligning', progress: 15, detail: '正在按实际音频对齐已知对白' })
      const candidate = await this.align({ ...configuration, inputPath: resolved.path, text: cue.text,
        language: job.request.language, durationMs, cueId: cue.id, cueFingerprint: cue.fingerprint,
        audioContentHash: cue.asset.contentHash, signal })
      assertSoundAlignmentCandidate(candidate, { durationMs })
      if (candidate.cueId !== cue.id || candidate.cueFingerprint !== cue.fingerprint || candidate.audioContentHash !== cue.asset.contentHash) {
        fail('SPEECH_ALIGNMENT_RESULT_INVALID', '对齐器返回了不匹配的音频身份', 500)
      }
      this.cue(job.request, job.alignmentMetadata)
      if (signal.aborted) throw signal.reason
      const contents = JSON.stringify({ candidate, durationMs })
      if (Buffer.byteLength(contents) > MAX_RESULT_BYTES) fail('SPEECH_ALIGNMENT_RESULT_LIMIT', '对齐结果超过容量上限', 413)
      await mkdir(this.rootDirectory, { recursive: true })
      await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', flush: true })
      if (signal.aborted) throw signal.reason
      await rename(temporary, output)
      await this.store.update(id, {
        status: 'completed', phase: 'completed', progress: 100, detail: '对齐完成，请预览并明确应用字幕时间', completedAt: Date.now(),
        alignmentMetadata: { ...job.alignmentMetadata, durationMs, wordCount: candidate.words.length, resultHash: sha256(contents) },
      })
      published = true
    } catch (error) {
      if (signal.reason?.code === 'JOB_TIMEOUT') throw error
      const cancelled = signal.aborted || this.store.get(id)?.cancelRequested
      await this.store.update(id, cancelled
        ? { status: 'cancelled', phase: 'cancelled', detail: '对齐已取消，字幕没有改变' }
        : { status: 'failed', phase: 'failed', detail: '对齐失败，字幕没有改变', error: {
            code: error.code || 'SPEECH_ALIGNMENT_FAILED', title: '本地对齐失败',
            message: redactSensitiveText(error.message), suggestions: ['检查对齐工具和模型', '确认当前对白与音频一致后重试'],
          } })
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error })
      if (!published) await unlink(output).catch((error) => { if (error.code !== 'ENOENT') throw error })
    }
  }

  async result(id) {
    const job = this.store.get(id)
    if (!ID.test(id) || job?.kind !== 'speech-alignment' || job.status !== 'completed' || !job.alignmentMetadata?.resultHash) {
      fail('SPEECH_ALIGNMENT_RESULT_UNAVAILABLE', '对齐结果尚未完成或已不可用', 409)
    }
    this.cue(job.request, job.alignmentMetadata)
    const path = join(this.rootDirectory, `${id}.json`)
    if ((await stat(path)).size > MAX_RESULT_BYTES) fail('SPEECH_ALIGNMENT_RESULT_INVALID', '对齐结果大小无效', 409)
    const contents = await readFile(path, 'utf8')
    if (sha256(contents) !== job.alignmentMetadata.resultHash) fail('SPEECH_ALIGNMENT_RESULT_INVALID', '对齐结果校验失败', 409)
    const result = JSON.parse(contents)
    assertSoundAlignmentCandidate(result.candidate, { durationMs: result.durationMs })
    return result
  }
}
