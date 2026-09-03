import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { startIsolatedBridge } from './qa-runtime.mjs'

async function requestJson(bridge, pathname, options = {}, expected = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json()
  assert.equal(response.status, expected, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

const now = Date.now()
const videoRequest = {
  mode: 'text-to-video',
  prompt: '远山薄雾中，一名侠客缓步穿过竹林，固定镜头，衣袂轻动。',
  scenario: 'cinematic-character',
  aspectRatio: '16:9',
  duration: 5,
  preset: 'fast',
  modelProfile: 'auto',
  seed: 7,
  audio: false,
  director: {
    camera: 'locked',
    motion: 'subtle',
    continuity: true,
    soundscape: '',
    music: '',
    constraints: '主体稳定，避免文字与水印。',
  },
  hasLastFrame: false,
}
const fixtures = [
  {
    id: 'archive-completed-a', kind: 'image', tool: 'pixelate', label: '已完成像素化',
    status: 'completed', phase: 'completed', progress: 100, detail: '处理完成', createdAt: now - 4,
    completedAt: now - 3, outputPath: join('D:\\private', 'completed.png'),
    logs: [{ at: now - 3, level: 'success', message: '完整完成证据' }],
  },
  {
    id: 'archive-completed-b', kind: 'video', tool: 'text-to-video', label: '已完成视频',
    status: 'completed', phase: 'completed', progress: 100, detail: '视频生成完成', createdAt: now - 3,
    completedAt: now - 2, outputPath: join('D:\\private', 'completed.mp4'),
    logs: [{ at: now - 2, level: 'success', message: '视频完成证据' }],
  },
  {
    id: 'archive-cancelled', kind: 'image', tool: 'remove-background', label: '已取消任务',
    status: 'cancelled', phase: 'cancelled', progress: 20, detail: '用户取消', createdAt: now - 2,
    logs: [{ at: now - 1, level: 'warning', message: '取消证据' }],
  },
  {
    id: 'archive-failed-video', kind: 'video', tool: 'text-to-video', label: '失败视频任务',
    status: 'failed', phase: 'failed', progress: 61, detail: '采样失败', createdAt: now - 1,
    updatedAt: now,
    requestHash: 'fixture-video-request-hash',
    request: videoRequest,
    outputPath: join('D:\\private', 'failed-output.mp4'),
    error: { code: 'GPU_OOM', title: '显存不足', message: '原始失败证据必须保留', suggestions: ['降低批量'] },
    logs: [{ at: now, level: 'error', message: 'GPU_OOM · 采样阶段' }],
    scheduling: {
      schemaVersion: 1,
      resourceClass: 'gpu',
      priority: 50,
      timeoutMs: 7_200_000,
      idempotencyKey: 'archive-source-request',
      attempt: 1,
      maxAttempts: 3,
      queuedAt: now - 1,
      startedAt: now - 1,
      finishedAt: now,
    },
  },
]

const bridge = await startIsolatedBridge('job-archive', {
  environment: {
    AEONQUILL_JOB_ACTIVE_LIMIT: '200',
    AEONQUILL_JOB_ARCHIVE_AFTER_DAYS: '3650',
    AEONQUILL_JOB_FAILED_ARCHIVE_AFTER_DAYS: '3650',
    AEONQUILL_JOB_RECENT_FAILURE_DAYS: '0',
    AEONQUILL_JOB_MIN_ACTIVE_FAILURES: '0',
  },
})

let failure
try {
  await writeFile(join(bridge.runtimeDirectory, 'jobs.json'), JSON.stringify(fixtures, null, 2), 'utf8')
  await bridge.restart()

  const before = await requestJson(bridge, '/api/jobs')
  assert.equal(before.jobs.length, fixtures.length)
  assert.equal(before.archive.total, 0)
  assert.equal(JSON.stringify(before).includes('D:\\private'), false)

  const archived = await requestJson(bridge, '/api/jobs', { method: 'DELETE' })
  assert.equal(archived.archived.length, fixtures.length)
  assert.equal(archived.archive.total, fixtures.length)
  assert.deepEqual(archived.protected, [])

  const active = await requestJson(bridge, '/api/jobs')
  assert.deepEqual(active.jobs, [])
  assert.equal(active.archive.byStatus.completed, 2)
  assert.equal(active.archive.byStatus.failed, 1)
  assert.equal(active.archive.byStatus.cancelled, 1)

  const firstPage = await requestJson(bridge, '/api/jobs/archive?limit=2')
  assert.equal(firstPage.jobs.length, 2)
  assert.ok(firstPage.nextCursor)
  assert.ok(firstPage.jobs.every((job) => job.archiveMetadata?.reason === 'manual'))
  const secondPage = await requestJson(bridge, `/api/jobs/archive?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`)
  assert.equal(secondPage.jobs.length, 2)
  assert.equal(secondPage.nextCursor, null)
  assert.equal(new Set([...firstPage.jobs, ...secondPage.jobs].map(({ id }) => id)).size, fixtures.length)
  const badCursor = await requestJson(bridge, '/api/jobs/archive?cursor=not-a-cursor', {}, 400)
  assert.equal(badCursor.error.code, 'JOB_ARCHIVE_CURSOR_INVALID')

  const failed = await requestJson(bridge, '/api/jobs/archive-failed-video')
  assert.equal(failed.job.error.code, 'GPU_OOM')
  assert.equal(failed.job.logs[0].message, 'GPU_OOM · 采样阶段')
  assert.equal(failed.job.archiveMetadata.reason, 'manual')
  assert.equal(JSON.stringify(failed).includes('D:\\private'), false)

  const retry = await requestJson(bridge, '/api/jobs/archive-failed-video/retry', {
    method: 'POST',
    headers: { 'idempotency-key': 'archive-retry-request' },
  }, 202)
  assert.equal(retry.job.retryOf, 'archive-failed-video')
  assert.equal(retry.job.scheduling.attempt, 2)

  await bridge.restart()
  const afterRestart = await requestJson(bridge, '/api/jobs/archive?limit=10')
  assert.equal(afterRestart.archive.total, fixtures.length)
  assert.equal(afterRestart.jobs.find(({ id }) => id === 'archive-failed-video').error.message, '原始失败证据必须保留')

  const activeFile = JSON.parse(await readFile(join(bridge.runtimeDirectory, 'jobs.json'), 'utf8'))
  assert.equal(activeFile.some(({ id }) => id.startsWith('archive-')), false)
  const archiveFile = JSON.parse(await readFile(join(bridge.runtimeDirectory, 'job-archive.json'), 'utf8'))
  assert.equal(archiveFile.schemaVersion, 1)
  assert.equal(archiveFile.jobs.length, fixtures.length)
  assert.equal(archiveFile.jobs.find(({ id }) => id === 'archive-failed-video').outputPath, join('D:\\private', 'failed-output.mp4'))

  const maintenance = await requestJson(bridge, '/api/jobs/archive/maintenance', { method: 'POST' })
  assert.deepEqual(maintenance.archived, [])
  assert.equal(maintenance.archive.total, fixtures.length)
} catch (error) {
  failure = error
  process.exitCode = 1
  console.error(error.stack || error.message)
} finally {
  const logs = bridge.logs()
  await bridge.stop({ keepRuntime: Boolean(failure) })
  if (failure) console.error(`QA runtime retained: ${bridge.runtimeDirectory}\n${logs.stdout}\n${logs.stderr}`)
}

if (!failure) console.log('✓ Job archive API preserves evidence, pagination, retry access and restart recovery')
