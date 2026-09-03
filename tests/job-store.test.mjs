import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { JobStore } from '../server/job-store.mjs'

async function withTempStore(t, initialJobs = []) {
  const directory = await mkdtemp(join(tmpdir(), 'miaohui-job-store-'))
  const filePath = join(directory, 'jobs.json')
  const jobs = typeof initialJobs === 'function' ? await initialJobs(directory) : initialJobs
  await writeFile(filePath, JSON.stringify(jobs), 'utf8')
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())))
    await rm(directory, { recursive: true, force: true })
  })
  const store = new JobStore(filePath)
  await store.load()
  return { store, filePath, directory }
}

test('load recovers queued jobs, marks running jobs as actionable failures, and preserves terminal jobs', async (t) => {
  let completedAssetPath
  const { store } = await withTempStore(t, async (directory) => {
    const assetsDirectory = join(directory, 'assets')
    await mkdir(assetsDirectory)
    completedAssetPath = join(assetsDirectory, 'completed.png')
    await writeFile(completedAssetPath, 'stable completed asset', 'utf8')
    return [
      {
        id: 'queued-job',
        status: 'queued',
        phase: 'queued',
        progress: 0,
        createdAt: 0,
        logs: [],
      },
      { id: 'running-job', status: 'running', phase: 'sampling', progress: 73, createdAt: 1 },
      {
        id: 'completed-job',
        status: 'completed',
        phase: 'completed',
        progress: 100,
        createdAt: 2,
        outputPath: completedAssetPath,
        assetUrl: '/api/assets/completed.png',
      },
    ]
  })

  assert.equal(store.get('queued-job').status, 'queued')
  assert.match(store.get('queued-job').detail, /恢复排队/)
  assert.ok(store.get('queued-job').recoveredAt)
  const interrupted = store.get('running-job')
  assert.equal(interrupted.status, 'failed')
  assert.equal(interrupted.phase, 'failed')
  assert.equal(interrupted.progress, 73)
  assert.equal(interrupted.error.code, 'BRIDGE_RESTARTED')
  assert.ok(interrupted.error.suggestions.length >= 1)
  assert.equal(store.get('completed-job').status, 'completed')
  assert.equal(await readFile(completedAssetPath, 'utf8'), 'stable completed asset')
})

test('idempotent add reuses the same request and rejects key reuse for different input', async (t) => {
  const { store } = await withTempStore(t)
  const original = {
    id: 'job-original',
    kind: 'image',
    status: 'queued',
    phase: 'queued',
    createdAt: 1,
    requestHash: 'hash-a',
    scheduling: { idempotencyKey: 'request-key' },
  }
  assert.equal((await store.addIdempotent(original)).created, true)
  const duplicate = await store.addIdempotent({ ...original, id: 'job-duplicate' })
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.job.id, 'job-original')
  await assert.rejects(
    store.addIdempotent({ ...original, id: 'job-conflict', requestHash: 'hash-b' }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409,
  )
})

test('public jobs strip private paths and process handles', async (t) => {
  const { store } = await withTempStore(t)
  const abortController = new AbortController()
  const job = {
    id: 'private-job',
    status: 'queued',
    phase: 'queued',
    createdAt: Date.now(),
    inputPath: 'C:\\private\\input.png',
    maskPath: 'C:\\private\\mask.png',
    lastFramePath: 'C:\\private\\last.png',
    outputPath: 'C:\\private\\output.png',
    subtitleSrtPath: 'C:\\private\\captions.srt',
    subtitleVttPath: 'C:\\private\\captions.vtt',
    subtitleAssPath: 'C:\\private\\captions.ass',
    abortController,
  }
  await store.add(job)

  const publicJob = store.publicJob(store.get(job.id))
  assert.equal(publicJob.inputPath, undefined)
  assert.equal(publicJob.maskPath, undefined)
  assert.equal(publicJob.lastFramePath, undefined)
  assert.equal(publicJob.outputPath, undefined)
  assert.equal(publicJob.subtitleSrtPath, undefined)
  assert.equal(publicJob.subtitleVttPath, undefined)
  assert.equal(publicJob.subtitleAssPath, undefined)
  assert.equal(publicJob.abortController, undefined)

  const persisted = JSON.parse(await readFile(store.filePath, 'utf8'))
  assert.equal(persisted[0].abortController, undefined)
})

test('concurrent updates serialize and terminal cleanup is persisted', async (t) => {
  const { store, filePath } = await withTempStore(t)
  await store.add({ id: 'job-a', status: 'queued', phase: 'queued', progress: 0, createdAt: 1 })
  await Promise.all([
    store.update('job-a', { status: 'running', progress: 20 }),
    store.log('job-a', 'info', 'started'),
  ])
  await store.update('job-a', { status: 'completed', phase: 'completed', progress: 100 })

  assert.equal(store.get('job-a').status, 'completed')
  assert.deepEqual(await store.clearTerminal(), ['job-a'])
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), [])
})

test('terminal jobs move into a durable paged archive without losing failure evidence', async (t) => {
  const { store, filePath } = await withTempStore(t, [
    {
      id: 'failed-job', kind: 'video', status: 'failed', phase: 'failed', progress: 71, createdAt: 1,
      error: { code: 'GPU_OOM', title: '显存不足', message: '保留诊断证据' },
      logs: [{ at: 2, level: 'error', message: '采样中断' }],
      scheduling: { idempotencyKey: 'failed-request' },
    },
    { id: 'completed-job', status: 'completed', createdAt: 2 },
    { id: 'protected-job', status: 'completed', createdAt: 3 },
    { id: 'running-job', status: 'queued', createdAt: 4, request: { sourceJobIds: ['completed-job'] } },
  ])

  const result = await store.archiveTerminal({
    now: 10,
    forceTerminal: true,
    protectedJobIds: ['protected-job'],
  })
  assert.deepEqual(result.archived, ['failed-job'])
  assert.equal(store.location('failed-job'), 'archived')
  assert.equal(store.location('completed-job'), 'active')
  assert.equal(store.get('failed-job').error.code, 'GPU_OOM')
  assert.equal(store.get('failed-job').logs[0].message, '采样中断')
  assert.equal(store.list().length, 3)
  assert.equal(store.listArchived().length, 1)

  const active = JSON.parse(await readFile(filePath, 'utf8'))
  assert.equal(active.some(({ id }) => id === 'failed-job'), false)
  const archive = JSON.parse(await readFile(store.archiveFilePath, 'utf8'))
  assert.equal(archive.schemaVersion, 1)
  assert.equal(archive.jobs[0].id, 'failed-job')
  assert.equal(archive.jobs[0].archiveMetadata.reason, 'manual')

  const reopened = new JobStore(filePath, { archiveFilePath: store.archiveFilePath })
  await reopened.load()
  assert.equal(reopened.location('failed-job'), 'archived')
  assert.equal(reopened.get('failed-job').error.message, '保留诊断证据')
  const firstPage = reopened.archivedPage({ limit: 1 })
  assert.equal(firstPage.jobs[0].id, 'failed-job')
  assert.equal(firstPage.nextCursor, null)
})

test('active copy wins after an interrupted cross-file archive write', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'miaohui-job-store-'))
  const filePath = join(directory, 'jobs.json')
  const archiveFilePath = join(directory, 'job-archive.json')
  const duplicate = { id: 'duplicate-job', status: 'completed', createdAt: 1 }
  await writeFile(filePath, JSON.stringify([duplicate]), 'utf8')
  await writeFile(archiveFilePath, JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    updatedAt: 2,
    jobs: [{ ...duplicate, archiveMetadata: { schemaVersion: 1, archivedAt: 2, reason: 'age' } }],
  }), 'utf8')
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())))
    await rm(directory, { recursive: true, force: true })
  })

  const store = new JobStore(filePath, { archiveFilePath })
  await store.load()
  assert.equal(store.location('duplicate-job'), 'active')
  assert.equal(store.listArchived().length, 0)
  assert.deepEqual(JSON.parse(await readFile(archiveFilePath, 'utf8')).jobs, [])
})

test('corrupt archive fails closed without replacing the evidence file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'miaohui-job-store-'))
  const filePath = join(directory, 'jobs.json')
  const archiveFilePath = join(directory, 'job-archive.json')
  const corruptEvidence = '{"schemaVersion":1,"revision":0,"jobs":[{"id":"queued-in-archive","status":"queued"}]}'
  await writeFile(filePath, '[]', 'utf8')
  await writeFile(archiveFilePath, corruptEvidence, 'utf8')
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())))
    await rm(directory, { recursive: true, force: true })
  })

  const store = new JobStore(filePath, { archiveFilePath })
  await assert.rejects(
    store.load(),
    (error) => error.code === 'JOB_ARCHIVE_CORRUPT' && error.status === 500,
  )
  assert.equal(await readFile(archiveFilePath, 'utf8'), corruptEvidence)
})
