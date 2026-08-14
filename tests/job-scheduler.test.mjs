import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  assertStorageCapacity,
  createEstimateCostEvent,
  createScheduling,
  JobScheduler,
} from '../server/job-scheduler.mjs'
import { JobStore } from '../server/job-store.mjs'

async function createHarness(t, resourceLimits = { cpu: 1, gpu: 1 }) {
  const directory = await mkdtemp(join(tmpdir(), 'miaohui-scheduler-'))
  const filePath = join(directory, 'jobs.json')
  await writeFile(filePath, '[]', 'utf8')
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())))
    await rm(directory, { recursive: true, force: true })
  })
  const store = new JobStore(filePath)
  await store.load()
  const scheduler = new JobScheduler({ store, resourceLimits })
  return { store, scheduler, filePath }
}

function makeJob(id, resourceClass, priority = 0, timeoutMs = 10_000) {
  const createdAt = Date.now()
  return {
    id,
    kind: 'test',
    status: 'queued',
    phase: 'queued',
    progress: 0,
    detail: 'queued',
    createdAt,
    updatedAt: createdAt,
    scheduling: createScheduling({
      resourceClass,
      priority,
      timeoutMs,
      idempotencyKey: `key-${id}`,
      queuedAt: createdAt,
    }),
    costEvents: [createEstimateCostEvent(id, resourceClass, 5_000, createdAt)],
  }
}

test('priority ordering is stable once a resource becomes available', async (t) => {
  const { store, scheduler } = await createHarness(t, { cpu: 1 })
  const order = []
  let releaseBlocker
  scheduler.register('test', async (jobId) => {
    order.push(jobId)
    if (jobId === 'blocker') await new Promise((resolvePromise) => { releaseBlocker = resolvePromise })
    await store.update(jobId, { status: 'completed', phase: 'completed', progress: 100 })
  })
  for (const job of [makeJob('blocker', 'cpu', 0), makeJob('low', 'cpu', 1), makeJob('high', 'cpu', 90)]) {
    await store.add(job)
    await scheduler.enqueue(job.id)
  }
  while (!releaseBlocker) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  releaseBlocker()
  await scheduler.waitForIdle()
  assert.deepEqual(order, ['blocker', 'high', 'low'])
})

test('CPU and GPU jobs can overlap while each resource keeps its own limit', async (t) => {
  const { store, scheduler } = await createHarness(t, { cpu: 1, gpu: 1 })
  const active = new Set()
  let observedOverlap = false
  const releases = new Map()
  scheduler.register('test', async (jobId) => {
    active.add(jobId)
    if (active.has('cpu') && active.has('gpu-a')) observedOverlap = true
    await new Promise((resolvePromise) => releases.set(jobId, resolvePromise))
    active.delete(jobId)
    await store.update(jobId, { status: 'completed', phase: 'completed', progress: 100 })
  })
  for (const job of [makeJob('cpu', 'cpu'), makeJob('gpu-a', 'gpu'), makeJob('gpu-b', 'gpu')]) {
    await store.add(job)
    await scheduler.enqueue(job.id)
  }
  while (!releases.has('cpu') || !releases.has('gpu-a')) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
  }
  assert.equal(observedOverlap, true)
  assert.equal(releases.has('gpu-b'), false)
  releases.get('cpu')()
  releases.get('gpu-a')()
  while (!releases.has('gpu-b')) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  releases.get('gpu-b')()
  await scheduler.waitForIdle()
})

test('queued cancellation prevents execution and running cancellation propagates AbortSignal', async (t) => {
  const { store, scheduler } = await createHarness(t, { gpu: 1 })
  let activeSignal
  let releaseActive
  scheduler.register('test', async (jobId, { signal }) => {
    activeSignal = signal
    await new Promise((resolvePromise) => { releaseActive = resolvePromise })
    await store.update(jobId, { status: 'cancelled', phase: 'cancelled' })
  })
  await store.add(makeJob('active', 'gpu'))
  await scheduler.enqueue('active')
  await store.add(makeJob('waiting', 'gpu'))
  await scheduler.enqueue('waiting')
  while (!releaseActive) await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(scheduler.cancel('waiting'), 'queued')
  assert.equal(scheduler.cancel('active'), 'running')
  assert.equal(activeSignal.aborted, true)
  await store.update('waiting', { status: 'cancelled', phase: 'cancelled' })
  releaseActive()
  await scheduler.waitForIdle()
  assert.equal(store.get('waiting').status, 'cancelled')
})

test('timeout becomes an actionable failure and records non-billable usage', async (t) => {
  const { store, scheduler } = await createHarness(t, { cpu: 1 })
  scheduler.register('test', async (_jobId, { signal }) => {
    await new Promise((resolvePromise, rejectPromise) => {
      signal.addEventListener('abort', () => rejectPromise(signal.reason), { once: true })
    })
  })
  const job = makeJob('timeout', 'cpu', 0, 1_000)
  await store.add(job)
  await scheduler.enqueue(job.id)
  await scheduler.waitForIdle()
  const failed = store.get(job.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'JOB_TIMEOUT')
  const usage = failed.costEvents.find((event) => event.type === 'usage')
  assert.equal(usage.billable, false)
  assert.equal(usage.amountMicros, 0)
  assert.ok(usage.quantity >= 900)
})

test('recovery only re-enqueues persisted queued jobs', async (t) => {
  const { store, scheduler } = await createHarness(t, { cpu: 1 })
  const executed = []
  scheduler.register('test', async (jobId) => {
    executed.push(jobId)
    await store.update(jobId, { status: 'completed', phase: 'completed', progress: 100 })
  })
  await store.add(makeJob('recover-me', 'cpu'))
  await store.add({ ...makeJob('already-failed', 'cpu'), status: 'failed', phase: 'failed' })
  assert.deepEqual(await scheduler.recover(), ['recover-me'])
  await scheduler.waitForIdle()
  assert.deepEqual(executed, ['recover-me'])
  assert.ok(store.get('recover-me').scheduling.recoveredAt)
})

test('storage preflight rejects simulated low disk capacity with HTTP 507 semantics', async () => {
  await assert.rejects(
    assertStorageCapacity('ignored', 80, {
      reserveBytes: 20,
      statfsImpl: async () => ({ bsize: 10, bavail: 9 }),
    }),
    (error) => error.code === 'STORAGE_CAPACITY_LOW' && error.status === 507,
  )
  const result = await assertStorageCapacity('ignored', 70, {
    reserveBytes: 20,
    statfsImpl: async () => ({ bsize: 10, bavail: 9 }),
  })
  assert.equal(result.freeBytes, 90)
})
