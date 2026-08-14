import { statfs } from 'node:fs/promises'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const RESOURCE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 3 * 60 * 60 * 1_000
const DEFAULT_STORAGE_RESERVE_BYTES = 128 * 1024 * 1024

function schedulerError(code, message, status = 500) {
  return Object.assign(new Error(message), { code, status })
}

function abortReason(code, message, name = 'AbortError') {
  return Object.assign(new Error(message), { code, name })
}

function normalizeLimit(value, resourceClass) {
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
    throw schedulerError('INVALID_RESOURCE_LIMIT', `Invalid concurrency limit for ${resourceClass}`)
  }
  return limit
}

function validateScheduling(job, resources) {
  const scheduling = job?.scheduling
  if (!scheduling || scheduling.schemaVersion !== 1) {
    throw schedulerError('INVALID_JOB_SCHEDULING', `Job ${job?.id || 'unknown'} has no scheduling metadata`, 409)
  }
  if (!RESOURCE_PATTERN.test(scheduling.resourceClass || '') || !resources.has(scheduling.resourceClass)) {
    throw schedulerError('UNKNOWN_RESOURCE_CLASS', `Unknown resource class: ${scheduling.resourceClass || 'missing'}`, 409)
  }
  if (!Number.isSafeInteger(scheduling.priority) || scheduling.priority < -100 || scheduling.priority > 100) {
    throw schedulerError('INVALID_JOB_PRIORITY', 'Job priority must be an integer from -100 to 100', 409)
  }
  if (
    !Number.isSafeInteger(scheduling.timeoutMs) ||
    scheduling.timeoutMs < MIN_TIMEOUT_MS ||
    scheduling.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw schedulerError('INVALID_JOB_TIMEOUT', 'Job timeout is outside the supported range', 409)
  }
  return scheduling
}

function costEvent(jobId, attempt, resourceClass, startedAt, finishedAt) {
  return {
    id: `${jobId}:usage:${attempt}`,
    at: finishedAt,
    type: 'usage',
    source: 'local-scheduler',
    unit: `${resourceClass}-millisecond`,
    quantity: Math.max(0, finishedAt - startedAt),
    amountMicros: 0,
    currency: 'CNY',
    billable: false,
  }
}

export function createScheduling({
  resourceClass,
  priority,
  timeoutMs,
  idempotencyKey,
  attempt = 1,
  maxAttempts = 3,
  queuedAt = Date.now(),
}) {
  if (!RESOURCE_PATTERN.test(resourceClass || '')) {
    throw schedulerError('UNKNOWN_RESOURCE_CLASS', 'Resource class is invalid', 400)
  }
  if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) {
    throw schedulerError('INVALID_JOB_PRIORITY', 'Job priority must be an integer from -100 to 100', 400)
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw schedulerError('INVALID_JOB_TIMEOUT', 'Job timeout is outside the supported range', 400)
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100) {
    throw schedulerError('INVALID_JOB_ATTEMPT', 'Job attempt is invalid', 400)
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < attempt || maxAttempts > 100) {
    throw schedulerError('INVALID_JOB_ATTEMPT', 'Job maxAttempts is invalid', 400)
  }
  return {
    schemaVersion: 1,
    resourceClass,
    priority,
    timeoutMs,
    idempotencyKey,
    attempt,
    maxAttempts,
    queuedAt,
  }
}

export function createEstimateCostEvent(jobId, resourceClass, estimatedMilliseconds, at = Date.now()) {
  if (!Number.isSafeInteger(estimatedMilliseconds) || estimatedMilliseconds < 0) {
    throw schedulerError('INVALID_COST_ESTIMATE', 'Estimated resource time is invalid', 400)
  }
  return {
    id: `${jobId}:estimate:1`,
    at,
    type: 'estimate',
    source: 'local-scheduler',
    unit: `${resourceClass}-millisecond`,
    quantity: estimatedMilliseconds,
    amountMicros: 0,
    currency: 'CNY',
    billable: false,
  }
}

export async function assertStorageCapacity(
  directory,
  requiredBytes,
  { reserveBytes = DEFAULT_STORAGE_RESERVE_BYTES, statfsImpl = statfs } = {},
) {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
    throw schedulerError('INVALID_STORAGE_ESTIMATE', 'Required storage estimate is invalid', 500)
  }
  const stats = await statfsImpl(directory)
  const blockSize = BigInt(stats.bsize)
  const availableBlocks = BigInt(stats.bavail ?? stats.bfree)
  const freeBytesBig = blockSize * availableBlocks
  const thresholdBig = BigInt(requiredBytes) + BigInt(reserveBytes)
  if (freeBytesBig < thresholdBig) {
    throw schedulerError(
      'STORAGE_CAPACITY_LOW',
      `Not enough free storage for this task; ${requiredBytes + reserveBytes} bytes are required including reserve`,
      507,
    )
  }
  return {
    freeBytes: Number(freeBytesBig > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : freeBytesBig),
    requiredBytes,
    reserveBytes,
  }
}

export class JobScheduler {
  constructor({ store, resourceLimits = { cpu: 1, gpu: 1 }, now = () => Date.now() }) {
    if (!store) throw schedulerError('JOB_STORE_REQUIRED', 'JobScheduler requires a JobStore')
    this.store = store
    this.now = now
    this.executors = new Map()
    this.pending = new Map()
    this.active = new Map()
    this.sequence = 0
    this.drainScheduled = false
    this.idleWaiters = new Set()
    this.resources = new Map(Object.entries(resourceLimits).map(([resourceClass, limit]) => {
      if (!RESOURCE_PATTERN.test(resourceClass)) {
        throw schedulerError('UNKNOWN_RESOURCE_CLASS', `Invalid resource class: ${resourceClass}`)
      }
      return [resourceClass, { limit: normalizeLimit(limit, resourceClass), activeJobs: new Set() }]
    }))
  }

  register(kind, executor) {
    if (typeof kind !== 'string' || !kind || typeof executor !== 'function') {
      throw schedulerError('INVALID_EXECUTOR', 'Executor registration is invalid')
    }
    this.executors.set(kind, executor)
    return this
  }

  snapshot() {
    const resources = {}
    for (const [resourceClass, resource] of this.resources) {
      resources[resourceClass] = {
        limit: resource.limit,
        activeJobs: [...resource.activeJobs],
        queuedJobs: [...this.pending.values()]
          .filter((entry) => entry.resourceClass === resourceClass)
          .sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt || a.sequence - b.sequence)
          .map((entry) => entry.jobId),
      }
    }
    return { resources }
  }

  async enqueue(jobId, { recovered = false } = {}) {
    if (this.pending.has(jobId) || this.active.has(jobId)) return this.store.get(jobId)
    const job = this.store.get(jobId)
    if (!job) throw schedulerError('JOB_NOT_FOUND', `Job ${jobId} was not found`, 404)
    if (job.status !== 'queued') return job
    if (!this.executors.has(job.kind)) {
      throw schedulerError('EXECUTOR_NOT_FOUND', `No executor is registered for ${job.kind}`, 409)
    }
    const scheduling = validateScheduling(job, this.resources)
    const queuedAt = recovered ? Math.min(scheduling.queuedAt || this.now(), this.now()) : scheduling.queuedAt || this.now()
    const entry = {
      jobId,
      resourceClass: scheduling.resourceClass,
      priority: scheduling.priority,
      queuedAt,
      sequence: this.sequence++,
    }
    this.pending.set(jobId, entry)
    await this.store.update(jobId, {
      scheduling: {
        ...scheduling,
        queuedAt,
        recoveredAt: recovered ? this.now() : scheduling.recoveredAt,
      },
      detail: recovered ? '本地服务已重启，任务已恢复排队' : job.detail,
    })
    this.scheduleDrain()
    return this.store.get(jobId)
  }

  async recover() {
    const queued = this.store.list()
      .filter((job) => job.status === 'queued')
      .sort((a, b) => (a.scheduling?.queuedAt || a.createdAt) - (b.scheduling?.queuedAt || b.createdAt))
    for (const job of queued) await this.enqueue(job.id, { recovered: true })
    return queued.map((job) => job.id)
  }

  cancel(jobId, reason = abortReason('JOB_CANCELLED', 'Task was cancelled')) {
    const pending = this.pending.get(jobId)
    if (pending) {
      this.pending.delete(jobId)
      this.resolveIdleIfNeeded()
      return 'queued'
    }
    const active = this.active.get(jobId)
    if (active) {
      active.controller.abort(reason)
      return 'running'
    }
    return null
  }

  scheduleDrain() {
    if (this.drainScheduled) return
    this.drainScheduled = true
    queueMicrotask(() => {
      this.drainScheduled = false
      this.drain()
    })
  }

  drain() {
    while (this.pending.size) {
      const next = [...this.pending.values()]
        .sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt || a.sequence - b.sequence)
        .find((entry) => {
          const resource = this.resources.get(entry.resourceClass)
          return resource.activeJobs.size < resource.limit
        })
      if (!next) break
      this.pending.delete(next.jobId)
      const resource = this.resources.get(next.resourceClass)
      resource.activeJobs.add(next.jobId)
      void this.run(next).finally(() => {
        resource.activeJobs.delete(next.jobId)
        this.active.delete(next.jobId)
        this.resolveIdleIfNeeded()
        this.scheduleDrain()
      })
    }
    this.resolveIdleIfNeeded()
  }

  async run(entry) {
    const job = this.store.get(entry.jobId)
    if (!job || TERMINAL_STATUSES.has(job.status)) return
    const scheduling = validateScheduling(job, this.resources)
    const executor = this.executors.get(job.kind)
    const controller = new AbortController()
    const startedAt = this.now()
    const deadlineAt = startedAt + scheduling.timeoutMs
    const active = { ...entry, controller, startedAt, deadlineAt }
    this.active.set(job.id, active)
    const timer = setTimeout(() => {
      controller.abort(abortReason('JOB_TIMEOUT', 'Task exceeded its safety timeout', 'TimeoutError'))
    }, scheduling.timeoutMs)

    await this.store.update(job.id, {
      status: 'running',
      scheduling: { ...scheduling, startedAt, deadlineAt },
    })

    try {
      await executor(job.id, { signal: controller.signal, scheduling: { ...scheduling, startedAt, deadlineAt } })
      const latest = this.store.get(job.id)
      if (latest && !TERMINAL_STATUSES.has(latest.status)) {
        await this.store.update(job.id, {
          status: 'failed',
          phase: 'failed',
          detail: '执行器未返回终态',
          error: {
            code: 'EXECUTOR_INCOMPLETE',
            title: '任务执行状态不完整',
            message: '本地执行器结束时没有提交成功、失败或取消状态。',
            suggestions: ['查看任务日志后重试'],
          },
        })
      }
    } catch (error) {
      const latest = this.store.get(job.id)
      if (latest && !TERMINAL_STATUSES.has(latest.status)) {
        const timedOut = controller.signal.reason?.code === 'JOB_TIMEOUT'
        await this.store.update(job.id, timedOut ? {
          status: 'failed',
          phase: 'failed',
          detail: '任务超过安全时限',
          error: {
            code: 'JOB_TIMEOUT',
            title: '任务执行超时',
            message: '任务已超过本地调度器允许的最长执行时间。',
            suggestions: ['降低尺寸或时长后重试', '检查执行器是否失去响应'],
          },
        } : {
          status: 'failed',
          phase: 'failed',
          detail: '调度执行失败',
          error: {
            code: error?.code || 'SCHEDULER_EXECUTION_FAILED',
            title: '本地调度执行失败',
            message: String(error?.message || 'Unknown scheduler execution error'),
            suggestions: ['查看任务日志后重试'],
          },
        })
      }
    } finally {
      clearTimeout(timer)
      const finishedAt = this.now()
      const latest = this.store.get(job.id)
      if (latest) {
        const usage = costEvent(job.id, scheduling.attempt, scheduling.resourceClass, startedAt, finishedAt)
        const costEvents = [...(latest.costEvents || []).filter((event) => event.id !== usage.id), usage]
        await this.store.update(job.id, {
          scheduling: { ...(latest.scheduling || scheduling), finishedAt },
          costEvents,
        })
      }
    }
  }

  waitForIdle() {
    if (!this.pending.size && !this.active.size) return Promise.resolve()
    return new Promise((resolvePromise) => this.idleWaiters.add(resolvePromise))
  }

  resolveIdleIfNeeded() {
    if (this.pending.size || this.active.size) return
    for (const resolvePromise of this.idleWaiters) resolvePromise()
    this.idleWaiters.clear()
  }
}
