import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  JOB_ARCHIVE_SCHEMA_VERSION,
  selectJobsForArchive,
  summarizeArchivedJobs,
} from './job-archive.mjs'
import { redactSensitiveText, sanitizePublicPayload } from './security.mjs'

const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])

function archiveError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

function assertArchiveDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== JOB_ARCHIVE_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.jobs)) {
    throw archiveError('JOB_ARCHIVE_CORRUPT', 'Job archive metadata is invalid', 500)
  }
  const ids = new Set()
  for (const job of value.jobs) {
    if (!job || typeof job !== 'object' || typeof job.id !== 'string' || ids.has(job.id)
      || !terminalStatuses.has(job.status) || !Number.isFinite(job.archiveMetadata?.archivedAt)) {
      throw archiveError('JOB_ARCHIVE_CORRUPT', 'Job archive contains an invalid or duplicate task', 500)
    }
    ids.add(job.id)
  }
  return value
}

function archivedSort(left, right) {
  return Number(right.archiveMetadata?.archivedAt || 0) - Number(left.archiveMetadata?.archivedAt || 0)
    || Number(right.createdAt || 0) - Number(left.createdAt || 0)
    || right.id.localeCompare(left.id)
}

function encodeCursor(job) {
  return Buffer.from(JSON.stringify([
    Number(job.archiveMetadata?.archivedAt || 0),
    Number(job.createdAt || 0),
    job.id,
  ]), 'utf8').toString('base64url')
}

function decodeCursor(cursor) {
  if (!cursor) return null
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!Array.isArray(value) || value.length !== 3 || !Number.isFinite(value[0])
      || !Number.isFinite(value[1]) || typeof value[2] !== 'string') throw new Error('invalid')
    return value
  } catch {
    throw archiveError('JOB_ARCHIVE_CURSOR_INVALID', 'Job archive cursor is invalid')
  }
}

export class JobStore {
  constructor(filePath, { getExecutionIdentity, archiveFilePath = `${filePath}.archive.json` } = {}) {
    this.filePath = filePath
    this.archiveFilePath = archiveFilePath
    this.getExecutionIdentity = typeof getExecutionIdentity === 'function' ? getExecutionIdentity : () => null
    this.jobs = new Map()
    this.archivedJobs = new Map()
    this.archiveRevision = 0
    this.listeners = new Set()
    this.writeChain = Promise.resolve()
  }

  async load() {
    await mkdir(dirname(this.filePath), { recursive: true })
    let archiveNeedsPersist = false
    try {
      const source = await readFile(this.filePath, 'utf8')
      const savedJobs = JSON.parse(source)
      if (!Array.isArray(savedJobs)) throw new Error('Job history must be an array')
      for (const job of savedJobs) {
        if (job.status === 'queued') {
          job.detail = '本地服务已重启，等待恢复排队'
          job.recoveredAt = Date.now()
          job.logs = [...(job.logs || []), {
            at: job.recoveredAt,
            level: 'warning',
            message: '本地服务重启，排队任务将由调度器恢复',
          }].slice(-120)
        } else if (!terminalStatuses.has(job.status)) {
          job.status = 'failed'
          job.phase = 'failed'
          job.progress = Math.min(job.progress || 0, 99)
          job.detail = '本地服务重启，原任务未能继续跟踪'
          job.error = {
            code: 'BRIDGE_RESTARTED',
            title: '任务跟踪已中断',
            message: '本地桥接服务在任务完成前重新启动。ComfyUI 中的原任务可能仍需手动检查。',
            suggestions: ['检查 ComfyUI 队列', '确认显存已释放后重新生成'],
          }
        }
        this.jobs.set(job.id, job)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Could not load job history: ${redactSensitiveText(error.message)}`)
    }
    try {
      const source = await readFile(this.archiveFilePath, 'utf8')
      const archive = assertArchiveDocument(JSON.parse(source))
      this.archiveRevision = archive.revision
      for (const job of archive.jobs) {
        if (this.jobs.has(job.id)) {
          archiveNeedsPersist = true
          continue
        }
        this.archivedJobs.set(job.id, job)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (archiveNeedsPersist) {
      this.archiveRevision += 1
      await this.persistArchive()
    }
    await this.persist()
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  listArchived() {
    return [...this.archivedJobs.values()].sort(archivedSort)
  }

  listAll() {
    return [...this.jobs.values(), ...this.archivedJobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id) {
    return this.jobs.get(id) || this.archivedJobs.get(id)
  }

  location(id) {
    if (this.jobs.has(id)) return 'active'
    if (this.archivedJobs.has(id)) return 'archived'
    return null
  }

  findByIdempotencyKey(idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) return null
    return this.listAll().find((job) => job.scheduling?.idempotencyKey === idempotencyKey) || null
  }

  async add(job) {
    if (job && job.executionIdentity === undefined) job.executionIdentity = this.getExecutionIdentity()
    if (this.archivedJobs.has(job.id)) {
      throw archiveError('JOB_ID_CONFLICT', 'Job id already exists in the archive', 409)
    }
    this.jobs.set(job.id, job)
    await this.changed(job)
    return job
  }

  async addIdempotent(job) {
    if (job && job.executionIdentity === undefined) job.executionIdentity = this.getExecutionIdentity()
    const idempotencyKey = job?.scheduling?.idempotencyKey
    const existing = this.findByIdempotencyKey(idempotencyKey)
    if (existing) {
      if (existing.requestHash !== job.requestHash || existing.kind !== job.kind) {
        throw Object.assign(new Error('Idempotency key is already bound to a different request'), {
          code: 'IDEMPOTENCY_CONFLICT',
          status: 409,
        })
      }
      return { job: existing, created: false }
    }
    if (this.jobs.has(job.id) || this.archivedJobs.has(job.id)) {
      throw Object.assign(new Error('Job id already exists'), { code: 'JOB_ID_CONFLICT', status: 409 })
    }
    this.jobs.set(job.id, job)
    await this.changed(job)
    return { job, created: true }
  }

  async update(id, patch) {
    const location = this.location(id)
    const current = this.get(id)
    if (!current) return null
    const next = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
      error: patch.error === undefined ? current.error : patch.error,
      logs: patch.logs === undefined ? current.logs : patch.logs,
    }
    if (location === 'archived') {
      this.archivedJobs.set(id, next)
      this.archiveRevision += 1
      await this.persistArchive()
    } else {
      this.jobs.set(id, next)
      await this.changed(next)
    }
    return next
  }

  async log(id, level, message) {
    const job = this.jobs.get(id)
    if (!job) return
    const logs = [...(job.logs || []), { at: Date.now(), level, message }].slice(-120)
    await this.update(id, { logs })
  }

  async clearTerminal(options = {}) {
    const result = await this.archiveTerminal({ ...options, forceTerminal: true })
    return result.archived
  }

  async archiveTerminal(options = {}) {
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
    const plan = selectJobsForArchive(this.list(), options)
    if (!plan.selected.length) {
      return {
        archived: [],
        protectedIds: plan.protectedIds,
        terminalBefore: plan.terminalBefore,
        terminalAfter: plan.terminalAfter,
        policy: plan.policy,
        summary: this.archiveSummary(),
      }
    }
    for (const { job, reason } of plan.selected) {
      const archived = {
        ...job,
        archiveMetadata: {
          schemaVersion: JOB_ARCHIVE_SCHEMA_VERSION,
          archivedAt: now,
          reason,
        },
      }
      this.jobs.delete(job.id)
      this.archivedJobs.set(job.id, archived)
    }
    this.archiveRevision += 1
    await this.persistArchiveAndActive()
    return {
      archived: plan.selected.map(({ job }) => job.id),
      protectedIds: plan.protectedIds,
      terminalBefore: plan.terminalBefore,
      terminalAfter: plan.terminalAfter,
      policy: plan.policy,
      summary: this.archiveSummary(),
    }
  }

  archiveSummary() {
    return {
      schemaVersion: JOB_ARCHIVE_SCHEMA_VERSION,
      revision: this.archiveRevision,
      ...summarizeArchivedJobs(this.listArchived()),
    }
  }

  archivedPage({ limit = 50, cursor = null } = {}) {
    const pageLimit = Math.max(1, Math.min(100, Math.round(Number(limit) || 50)))
    const decodedCursor = decodeCursor(cursor)
    const jobs = this.listArchived()
    let start = 0
    if (decodedCursor) {
      const index = jobs.findIndex((job) => (
        Number(job.archiveMetadata?.archivedAt || 0) === decodedCursor[0]
        && Number(job.createdAt || 0) === decodedCursor[1]
        && job.id === decodedCursor[2]
      ))
      if (index < 0) throw archiveError('JOB_ARCHIVE_CURSOR_STALE', 'Job archive changed; restart pagination', 409)
      start = index + 1
    }
    const page = jobs.slice(start, start + pageLimit)
    return {
      jobs: page,
      nextCursor: start + page.length < jobs.length && page.length ? encodeCursor(page.at(-1)) : null,
      summary: this.archiveSummary(),
    }
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publicJob(job) {
    if (!job) return null
    const {
      inputPath: _inputPath,
      maskPath: _maskPath,
      lastFramePath: _lastFramePath,
      outputPath: _outputPath,
      temporaryOutputPath: _temporaryOutputPath,
      subtitleSrtPath: _subtitleSrtPath,
      subtitleVttPath: _subtitleVttPath,
      subtitleAssPath: _subtitleAssPath,
      abortController: _abortController,
      ...safe
    } = job
    return sanitizePublicPayload(safe)
  }

  async changed(job) {
    await this.persist()
    const publicJob = this.publicJob(job)
    for (const listener of this.listeners) listener(publicJob)
  }

  persist() {
    const payload = JSON.stringify(this.list().map((job) => {
      const { abortController: _abortController, ...persistable } = job
      return persistable
    }), null, 2)
    return this.enqueueWrite(this.filePath, payload)
  }

  persistArchive() {
    const payload = JSON.stringify({
      schemaVersion: JOB_ARCHIVE_SCHEMA_VERSION,
      revision: this.archiveRevision,
      updatedAt: Date.now(),
      jobs: this.listArchived().map((job) => {
        const { abortController: _abortController, ...persistable } = job
        return persistable
      }),
    }, null, 2)
    return this.enqueueWrite(this.archiveFilePath, payload)
  }

  persistArchiveAndActive() {
    const archivePayload = JSON.stringify({
      schemaVersion: JOB_ARCHIVE_SCHEMA_VERSION,
      revision: this.archiveRevision,
      updatedAt: Date.now(),
      jobs: this.listArchived().map((job) => {
        const { abortController: _abortController, ...persistable } = job
        return persistable
      }),
    }, null, 2)
    const activePayload = JSON.stringify(this.list().map((job) => {
      const { abortController: _abortController, ...persistable } = job
      return persistable
    }), null, 2)
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await this.atomicWrite(this.archiveFilePath, archivePayload)
        await this.atomicWrite(this.filePath, activePayload)
      })
    return this.writeChain
  }

  enqueueWrite(filePath, payload) {
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(() => this.atomicWrite(filePath, payload))
    return this.writeChain
  }

  async atomicWrite(filePath, payload) {
    await mkdir(dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.${process.pid}.tmp`
    await writeFile(temporaryPath, payload, 'utf8')
    try {
      await rename(temporaryPath, filePath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => {})
      throw error
    }
  }
}
