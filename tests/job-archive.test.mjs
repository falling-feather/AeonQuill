import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectJobReferenceIds,
  normalizeJobArchivePolicy,
  selectJobsForArchive,
  summarizeArchivedJobs,
} from '../server/job-archive.mjs'

const DAY = 24 * 60 * 60 * 1_000

function job(id, status, createdAt, extra = {}) {
  return { id, status, createdAt, ...extra }
}

test('collects only explicit nested job references', () => {
  const references = collectJobReferenceIds({
    id: 'self-is-not-a-reference',
    jobId: 'job-direct',
    sourceJobIds: ['job-source-a', 'job-source-b'],
    nested: { childJobId: 'job-child', retryOf: 'job-retry-source' },
    ignored: ['job-not-referenced'],
    idempotencyKey: 'job-not-an-id',
  })
  assert.deepEqual([...references].sort(), [
    'job-child',
    'job-direct',
    'job-retry-source',
    'job-source-a',
    'job-source-b',
  ])
})

test('automatic archive protects active dependencies, project references and recent failures', () => {
  const now = 200 * DAY
  const jobs = [
    job('job-running', 'running', now, { request: { sourceJobIds: ['job-active-source'] } }),
    job('job-active-source', 'completed', now - 100 * DAY),
    job('job-project-reference', 'completed', now - 100 * DAY, { request: { sourceJobIds: ['job-project-source'] } }),
    job('job-project-source', 'completed', now - 100 * DAY),
    job('job-old-completed', 'completed', now - 40 * DAY),
    job('job-old-failed', 'failed', now - 100 * DAY),
    job('job-recent-failed', 'failed', now - DAY),
  ]
  const result = selectJobsForArchive(jobs, {
    now,
    protectedJobIds: ['job-project-reference'],
    policy: {
      maxActiveTerminalJobs: 100,
      archiveAfterDays: 30,
      failedArchiveAfterDays: 60,
      recentFailureDays: 14,
      minActiveFailures: 1,
    },
  })
  assert.deepEqual(result.selected.map(({ job: selected }) => selected.id), [
    'job-old-failed',
    'job-old-completed',
  ])
  assert.deepEqual(new Set(result.protectedIds), new Set([
    'job-active-source',
    'job-project-reference',
    'job-project-source',
    'job-recent-failed',
    'job-running',
  ]))
})

test('active count archives oldest terminal jobs deterministically and manual mode keeps external references', () => {
  const jobs = Array.from({ length: 5 }, (_, index) => job(`job-${index + 1}`, 'completed', index + 1))
  const automatic = selectJobsForArchive(jobs, {
    now: 10,
    policy: { maxActiveTerminalJobs: 2, archiveAfterDays: 30 },
  })
  assert.deepEqual(automatic.selected.map(({ job: selected }) => selected.id), ['job-1', 'job-2', 'job-3'])
  assert.ok(automatic.selected.every(({ reason }) => reason === 'active-limit'))

  const manual = selectJobsForArchive([
    job('job-completed', 'completed', 1),
    job('job-failed', 'failed', 2),
    job('job-protected', 'cancelled', 3),
  ], {
    now: 10,
    forceTerminal: true,
    protectedJobIds: ['job-protected'],
  })
  assert.deepEqual(manual.selected.map(({ job: selected }) => selected.id), ['job-completed', 'job-failed'])
  assert.ok(manual.selected.every(({ reason }) => reason === 'manual'))
})

test('policy bounds and archive summary stay machine-readable', () => {
  assert.deepEqual(normalizeJobArchivePolicy({
    maxActiveTerminalJobs: 0,
    archiveAfterDays: -2,
    failedArchiveAfterDays: 2,
    recentFailureDays: 999,
  }), {
    maxActiveTerminalJobs: 1,
    archiveAfterDays: 1,
    failedArchiveAfterDays: 2,
    recentFailureDays: 365,
    minActiveFailures: 20,
  })
  assert.deepEqual(summarizeArchivedJobs([
    job('a', 'completed', 1, { archiveMetadata: { archivedAt: 10 } }),
    job('b', 'failed', 2, { archiveMetadata: { archivedAt: 20 } }),
  ]), {
    total: 2,
    byStatus: { completed: 1, failed: 1, cancelled: 0 },
    oldestArchivedAt: 10,
    newestArchivedAt: 20,
  })
})
