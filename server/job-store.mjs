import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { redactSensitiveText, sanitizePublicPayload } from './security.mjs'

const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])

export class JobStore {
  constructor(filePath) {
    this.filePath = filePath
    this.jobs = new Map()
    this.listeners = new Set()
    this.writeChain = Promise.resolve()
  }

  async load() {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const source = await readFile(this.filePath, 'utf8')
      const savedJobs = JSON.parse(source)
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
      await this.persist()
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Could not load job history: ${redactSensitiveText(error.message)}`)
    }
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id) {
    return this.jobs.get(id)
  }

  findByIdempotencyKey(idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) return null
    return this.list().find((job) => job.scheduling?.idempotencyKey === idempotencyKey) || null
  }

  async add(job) {
    this.jobs.set(job.id, job)
    await this.changed(job)
    return job
  }

  async addIdempotent(job) {
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
    if (this.jobs.has(job.id)) {
      throw Object.assign(new Error('Job id already exists'), { code: 'JOB_ID_CONFLICT', status: 409 })
    }
    this.jobs.set(job.id, job)
    await this.changed(job)
    return { job, created: true }
  }

  async update(id, patch) {
    const current = this.jobs.get(id)
    if (!current) return null
    const next = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
      error: patch.error === undefined ? current.error : patch.error,
      logs: patch.logs === undefined ? current.logs : patch.logs,
    }
    this.jobs.set(id, next)
    await this.changed(next)
    return next
  }

  async log(id, level, message) {
    const job = this.jobs.get(id)
    if (!job) return
    const logs = [...(job.logs || []), { at: Date.now(), level, message }].slice(-120)
    await this.update(id, { logs })
  }

  async clearTerminal() {
    const removed = []
    for (const [id, job] of this.jobs) {
      if (terminalStatuses.has(job.status)) {
        this.jobs.delete(id)
        removed.push(id)
      }
    }
    await this.persist()
    return removed
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publicJob(job) {
    if (!job) return null
    const {
      inputPath: _inputPath,
      lastFramePath: _lastFramePath,
      outputPath: _outputPath,
      temporaryOutputPath: _temporaryOutputPath,
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
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await writeFile(temporaryPath, payload, 'utf8')
        try {
          await rename(temporaryPath, this.filePath)
        } catch (error) {
          await unlink(temporaryPath).catch(() => {})
          throw error
        }
      })
    return this.writeChain
  }
}
