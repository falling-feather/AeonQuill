export const JOB_ARCHIVE_SCHEMA_VERSION = 1

export const DEFAULT_JOB_ARCHIVE_POLICY = Object.freeze({
  maxActiveTerminalJobs: 200,
  archiveAfterDays: 30,
  failedArchiveAfterDays: 90,
  recentFailureDays: 14,
  minActiveFailures: 20,
})

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u
const DAY_MS = 24 * 60 * 60 * 1_000

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)))
}

export function normalizeJobArchivePolicy(value = {}) {
  const archiveAfterDays = boundedInteger(value.archiveAfterDays, DEFAULT_JOB_ARCHIVE_POLICY.archiveAfterDays, 1, 3_650)
  return {
    maxActiveTerminalJobs: boundedInteger(value.maxActiveTerminalJobs, DEFAULT_JOB_ARCHIVE_POLICY.maxActiveTerminalJobs, 1, 10_000),
    archiveAfterDays,
    failedArchiveAfterDays: Math.max(
      archiveAfterDays,
      boundedInteger(value.failedArchiveAfterDays, DEFAULT_JOB_ARCHIVE_POLICY.failedArchiveAfterDays, 1, 3_650),
    ),
    recentFailureDays: boundedInteger(value.recentFailureDays, DEFAULT_JOB_ARCHIVE_POLICY.recentFailureDays, 0, 365),
    minActiveFailures: boundedInteger(value.minActiveFailures, DEFAULT_JOB_ARCHIVE_POLICY.minActiveFailures, 0, 1_000),
  }
}

function addReference(value, references) {
  if (typeof value === 'string' && SAFE_JOB_ID.test(value)) references.add(value)
  if (Array.isArray(value)) value.forEach((entry) => addReference(entry, references))
}

export function collectJobReferenceIds(value, references = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return references
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((entry) => collectJobReferenceIds(entry, references, seen))
    return references
  }
  for (const [key, child] of Object.entries(value)) {
    if (/jobIds?$/iu.test(key) || key === 'retryOf') addReference(child, references)
    collectJobReferenceIds(child, references, seen)
  }
  return references
}

function jobTimestamp(job) {
  return Number(job.scheduling?.finishedAt || job.completedAt || job.updatedAt || job.createdAt || 0)
}

function dependencyClosure(jobsById, seedIds) {
  const protectedIds = new Set([...seedIds].filter((id) => jobsById.has(id)))
  const pending = [...protectedIds]
  while (pending.length) {
    const currentId = pending.pop()
    const current = jobsById.get(currentId)
    if (!current) continue
    const references = collectJobReferenceIds(current)
    references.delete(current.id)
    for (const reference of references) {
      if (!jobsById.has(reference) || protectedIds.has(reference)) continue
      protectedIds.add(reference)
      pending.push(reference)
    }
  }
  return protectedIds
}

export function selectJobsForArchive(activeJobs, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const policy = normalizeJobArchivePolicy(options.policy)
  const forceTerminal = options.forceTerminal === true
  const jobsById = new Map(activeJobs.map((job) => [job.id, job]))
  const seedIds = new Set(options.protectedJobIds || [])

  for (const job of activeJobs) {
    if (!TERMINAL_STATUSES.has(job.status)) seedIds.add(job.id)
  }

  if (!forceTerminal) {
    const recentFailureCutoff = now - policy.recentFailureDays * DAY_MS
    const failures = activeJobs
      .filter((job) => job.status === 'failed')
      .sort((left, right) => jobTimestamp(right) - jobTimestamp(left) || right.id.localeCompare(left.id))
    failures.slice(0, policy.minActiveFailures).forEach((job) => seedIds.add(job.id))
    failures.filter((job) => jobTimestamp(job) >= recentFailureCutoff).forEach((job) => seedIds.add(job.id))
  }

  const protectedIds = dependencyClosure(jobsById, seedIds)
  const terminalJobs = activeJobs
    .filter((job) => TERMINAL_STATUSES.has(job.status))
    .sort((left, right) => jobTimestamp(left) - jobTimestamp(right) || left.id.localeCompare(right.id))
  let remainingTerminal = terminalJobs.length
  const selected = []

  for (const job of terminalJobs) {
    if (protectedIds.has(job.id)) continue
    const ageDays = Math.max(0, (now - jobTimestamp(job)) / DAY_MS)
    const ageLimit = job.status === 'failed' ? policy.failedArchiveAfterDays : policy.archiveAfterDays
    const overLimit = remainingTerminal > policy.maxActiveTerminalJobs
    if (!forceTerminal && ageDays < ageLimit && !overLimit) continue
    selected.push({
      job,
      reason: forceTerminal ? 'manual' : ageDays >= ageLimit ? 'age' : 'active-limit',
    })
    remainingTerminal -= 1
  }

  return {
    selected,
    protectedIds: [...protectedIds].sort(),
    policy,
    terminalBefore: terminalJobs.length,
    terminalAfter: remainingTerminal,
  }
}

export function summarizeArchivedJobs(jobs) {
  const byStatus = { completed: 0, failed: 0, cancelled: 0 }
  let oldestArchivedAt = null
  let newestArchivedAt = null
  for (const job of jobs) {
    if (Object.hasOwn(byStatus, job.status)) byStatus[job.status] += 1
    const archivedAt = Number(job.archiveMetadata?.archivedAt || 0)
    if (!archivedAt) continue
    oldestArchivedAt = oldestArchivedAt === null ? archivedAt : Math.min(oldestArchivedAt, archivedAt)
    newestArchivedAt = newestArchivedAt === null ? archivedAt : Math.max(newestArchivedAt, archivedAt)
  }
  return {
    total: jobs.length,
    byStatus,
    oldestArchivedAt,
    newestArchivedAt,
  }
}
