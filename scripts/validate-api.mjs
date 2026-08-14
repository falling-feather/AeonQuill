import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import { startIsolatedBridge } from './qa-runtime.mjs'

const sourcePath = fileURLToPath(new URL('../src/assets/sample-summer-character.png', import.meta.url))

async function requestJson(baseUrl, pathname, options = {}, expectedStatus = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json()
  assert.equal(response.status, expectedStatus, `${options.method || 'GET'} ${pathname}: ${JSON.stringify(payload)}`)
  return payload
}

function assertPublicJob(job) {
  for (const privateKey of ['inputPath', 'lastFramePath', 'outputPath', 'temporaryOutputPath', 'abortController']) {
    assert.ok(!(privateKey in job), `public job must not expose ${privateKey}`)
  }
}

function requestWithHostHeader(baseUrl, pathname, hostHeader) {
  const target = new URL(pathname, baseUrl)
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { host: hostHeader, cookie: bridge.sessionCookie },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolvePromise({
        status: response.statusCode,
        payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }))
    })
    request.once('error', rejectPromise)
    request.end()
  })
}

async function waitForTerminalJob(baseUrl, jobId) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const { job } = await requestJson(baseUrl, `/api/jobs/${encodeURIComponent(jobId)}`)
    assertPublicJob(job)
    if (
      ['completed', 'failed', 'cancelled'].includes(job.status) &&
      (!job.scheduling || job.scheduling.finishedAt)
    ) return job
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  }
  throw new Error(`Timed out waiting for image job ${jobId}`)
}

const bridge = await startIsolatedBridge('api')
let failed = true
try {
  const initialHealthResponse = await fetch(`${bridge.baseUrl}/api/health`)
  assert.equal(initialHealthResponse.status, 200)
  assert.match(initialHealthResponse.headers.get('set-cookie') || '', /^miaohui_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict/)
  assert.match(initialHealthResponse.headers.get('content-security-policy') || '', /default-src 'self'/)
  assert.equal(initialHealthResponse.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(initialHealthResponse.headers.get('x-frame-options'), 'DENY')
  const health = await initialHealthResponse.json()
  assert.equal(health.ok, true)
  assert.equal(health.service, 'miaohui-local-bridge')

  const noSession = await fetch(`${bridge.baseUrl}/api/jobs`)
  assert.equal(noSession.status, 401)
  assert.equal((await noSession.json()).error.code, 'SESSION_REQUIRED')

  const evilOrigin = await fetch(`${bridge.baseUrl}/api/jobs`, {
    headers: { cookie: bridge.sessionCookie, origin: 'https://evil.example' },
  })
  assert.equal(evilOrigin.status, 403)
  assert.equal((await evilOrigin.json()).error.code, 'ORIGIN_NOT_ALLOWED')
  assert.equal(evilOrigin.headers.get('access-control-allow-origin'), null)

  const crossSiteWithoutOrigin = await fetch(`${bridge.baseUrl}/api/jobs`, {
    headers: { cookie: bridge.sessionCookie, 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSiteWithoutOrigin.status, 403)
  assert.equal((await crossSiteWithoutOrigin.json()).error.code, 'ORIGIN_NOT_ALLOWED')

  const evilHost = await requestWithHostHeader(bridge.baseUrl, '/api/jobs', 'evil.example')
  assert.equal(evilHost.status, 421)
  assert.equal(evilHost.payload.error.code, 'HOST_NOT_ALLOWED')

  const allowedPreflight = await fetch(`${bridge.baseUrl}/api/jobs`, {
    method: 'OPTIONS',
    headers: { origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'GET' },
  })
  assert.equal(allowedPreflight.status, 204)
  assert.equal(allowedPreflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173')
  assert.equal(allowedPreflight.headers.get('access-control-allow-credentials'), 'true')

  const workflows = await requestJson(bridge.baseUrl, '/api/workflows')
  assert.deepEqual(workflows.modes.map(({ id }) => id), ['text-to-video', 'image-to-video'])
  assert.ok(workflows.presets.some(({ id }) => id === 'delivery720'))

  const imageTools = await requestJson(bridge.baseUrl, '/api/image-tools?refresh=1')
  const pixelate = imageTools.operations.find(({ id }) => id === 'pixelate')
  assert.equal(pixelate.available, true)

  const source = await readFile(sourcePath)
  const embeddedSource = `data:image/png;base64,${source.toString('base64')}`
  const projectDocument = {
    schemaVersion: 1,
    id: 'qa-project',
    title: 'QA project',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    elements: [{
      id: 'qa-image', kind: 'image', name: 'QA image', x: 0, y: 0, width: 256, height: 256,
      rotation: 0, opacity: 1, radius: 0, fill: '#fff', stroke: '#000',
      src: embeddedSource, sourceSrc: embeddedSource, locked: false, visible: true, zIndex: 1,
    }],
  }
  const savedProject = await requestJson(bridge.baseUrl, '/api/projects/current', {
    method: 'PUT', body: JSON.stringify({ document: projectDocument }),
  })
  assert.equal(savedProject.project.revision, 1)
  assert.equal(savedProject.project.assets.length, 1)
  assert.match(savedProject.project.assets[0].id, /^[a-f0-9]{64}$/)
  assert.equal(savedProject.project.document.elements[0].src, savedProject.project.assets[0].url)
  assert.equal(savedProject.project.document.elements[0].sourceSrc, savedProject.project.assets[0].url)

  const loadedProject = await requestJson(bridge.baseUrl, '/api/projects/current?id=qa-project')
  assert.deepEqual(loadedProject.project.document, savedProject.project.document)
  const projectAsset = await bridge.request(savedProject.project.assets[0].url)
  assert.equal(projectAsset.status, 200)
  assert.equal(projectAsset.headers.get('content-type'), 'image/png')
  assert.equal((await projectAsset.arrayBuffer()).byteLength, source.length)
  const projectThumbnail = await bridge.request(`${savedProject.project.assets[0].url}?variant=thumbnail-v1`)
  assert.equal(projectThumbnail.status, 200)
  assert.equal(projectThumbnail.headers.get('content-type'), 'image/webp')
  assert.equal(projectThumbnail.headers.get('x-miaohui-asset-tier'), 'thumbnail-v1')
  const thumbnailBytes = Buffer.from(await projectThumbnail.arrayBuffer())
  assert.deepEqual(thumbnailBytes.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.ok(thumbnailBytes.byteLength < source.length)
  const projectPreview = await bridge.request(`${savedProject.project.assets[0].url}?variant=preview-v1`, {
    method: 'HEAD',
  })
  assert.equal(projectPreview.status, 200)
  assert.equal(projectPreview.headers.get('content-type'), 'image/webp')
  assert.equal(projectPreview.headers.get('x-miaohui-asset-tier'), 'preview-v1')
  const invalidVariant = await requestJson(
    bridge.baseUrl,
    `${savedProject.project.assets[0].url}?variant=unknown`,
    {},
    400,
  )
  assert.equal(invalidVariant.error.code, 'INVALID_ASSET_VARIANT')
  const projectAssetRange = await bridge.request(savedProject.project.assets[0].url, {
    headers: { range: 'bytes=0-15' },
  })
  assert.equal(projectAssetRange.status, 206)
  assert.equal((await projectAssetRange.arrayBuffer()).byteLength, 16)

  const revisionConflict = await requestJson(bridge.baseUrl, '/api/projects/current', {
    method: 'PUT',
    body: JSON.stringify({
      document: {
        ...savedProject.project.document,
        elements: [{ ...savedProject.project.document.elements[0], x: 10 }],
      },
    }),
  }, 409)
  assert.equal(revisionConflict.error.code, 'PROJECT_REVISION_CONFLICT')

  const advancedProject = await requestJson(bridge.baseUrl, '/api/projects/current', {
    method: 'PUT',
    body: JSON.stringify({
      document: {
        ...savedProject.project.document,
        revision: 2,
        updatedAt: 3,
        elements: [{ ...savedProject.project.document.elements[0], x: 10 }],
      },
    }),
  })
  assert.equal(advancedProject.project.revision, 2)

  const packageResponse = await bridge.request('/api/projects/current/package?id=qa-project')
  assert.equal(packageResponse.status, 200)
  assert.equal(packageResponse.headers.get('content-type'), 'application/vnd.miaohui.project')
  const projectPackage = Buffer.from(await packageResponse.arrayBuffer())
  assert.deepEqual([...projectPackage.subarray(0, 2)], [0x1f, 0x8b])
  const importedProject = await requestJson(bridge.baseUrl, '/api/projects/import?projectId=qa-copy', {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.miaohui.project' },
    body: projectPackage,
  }, 201)
  assert.equal(importedProject.project.id, 'qa-copy')
  assert.equal(importedProject.project.document.elements[0].assetId, savedProject.project.document.elements[0].assetId)
  assert.equal(importedProject.project.assetVersions[0].assetId, savedProject.project.assets[0].id)
  const gcResult = await requestJson(bridge.baseUrl, '/api/projects/gc', { method: 'POST' })
  assert.deepEqual(gcResult.removed, [])

  const initialJobs = await requestJson(bridge.baseUrl, '/api/jobs')
  assert.deepEqual(initialJobs.jobs, [])
  const scheduler = await requestJson(bridge.baseUrl, '/api/scheduler')
  assert.equal(scheduler.resources.cpu.limit >= 1, true)
  assert.equal(scheduler.resources.gpu.limit, 1)

  const invalidVideo = await requestJson(bridge.baseUrl, '/api/jobs/video', {
    method: 'POST', body: JSON.stringify({ mode: 'text-to-video', prompt: '' }),
  }, 400)
  assert.equal(invalidVideo.error.code, 'REQUEST_FAILED')

  const invalidImage = await requestJson(bridge.baseUrl, '/api/jobs/image', {
    method: 'POST', body: JSON.stringify({ operation: 'not-a-tool' }),
  }, 400)
  assert.equal(invalidImage.error.code, 'IMAGE_OPERATION_UNSUPPORTED')

  const sseController = new AbortController()
  const sse = await bridge.request('/api/jobs/events', { signal: sseController.signal })
  assert.equal(sse.status, 200)
  assert.match(sse.headers.get('content-type') || '', /text\/event-stream/)
  const firstEvent = new TextDecoder().decode((await sse.body.getReader().read()).value)
  assert.match(firstEvent, /"type":"jobs\.snapshot"/)
  sseController.abort()

  const imageJobBody = JSON.stringify({
    operation: 'pixelate',
    sourceElementId: 'qa-source',
    sourceImageDataUrl: `data:image/png;base64,${source.toString('base64')}`,
    params: { targetSize: 32, colors: 8, outputScale: 1, dither: 'none', alphaThreshold: 96 },
  })
  const created = await requestJson(bridge.baseUrl, '/api/jobs/image', {
    method: 'POST',
    headers: { 'idempotency-key': 'qa-pixel-request-001', 'x-miaohui-priority': '77' },
    body: imageJobBody,
  }, 202)
  assertPublicJob(created.job)
  assert.equal(created.reused, false)
  assert.equal(created.job.scheduling.resourceClass, 'cpu')
  assert.equal(created.job.scheduling.priority, 77)
  const duplicate = await requestJson(bridge.baseUrl, '/api/jobs/image', {
    method: 'POST',
    headers: { 'idempotency-key': 'qa-pixel-request-001', 'x-miaohui-priority': '77' },
    body: imageJobBody,
  }, 200)
  assert.equal(duplicate.reused, true)
  assert.equal(duplicate.job.id, created.job.id)
  const completed = await waitForTerminalJob(bridge.baseUrl, created.job.id)
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error || completed))
  assert.equal(completed.output.width, 32)
  assert.equal(completed.output.height, 32)
  assert.equal(completed.output.mimeType, 'image/png')
  assert.match(completed.outputUrl, /^\/api\/assets\//)
  assert.match(completed.outputVersion.id, /^asset-version-[a-f0-9]{32}$/)
  assert.equal(completed.outputVersion.logicalAssetId, `asset-job-${completed.id}`)
  assert.equal(completed.outputVersion.version, 1)
  assert.equal(completed.scheduling.attempt, 1)
  assert.ok(completed.costEvents.some((event) => event.type === 'estimate'))
  assert.ok(completed.costEvents.some((event) => event.type === 'usage' && event.billable === false))

  const asset = await bridge.request(completed.outputUrl)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('content-type'), 'image/png')
  const assetBytes = Buffer.from(await asset.arrayBuffer())
  assert.ok(assetBytes.byteLength > 0)
  assert.equal(createHash('sha256').update(assetBytes).digest('hex'), completed.outputVersion.assetId)

  const range = await bridge.request(completed.outputUrl, { headers: { range: 'bytes=0-15' } })
  assert.equal(range.status, 206)
  assert.match(range.headers.get('content-range') || '', /^bytes 0-15\//)
  assert.equal((await range.arrayBuffer()).byteLength, 16)

  const traversal = await bridge.request('/api/assets/%2e%2e%5cjobs.json')
  assert.equal(traversal.status, 403)
  assert.equal((await traversal.json()).error.code, 'FORBIDDEN_PATH')

  const listed = await requestJson(bridge.baseUrl, '/api/jobs')
  assert.equal(listed.jobs.length, 1)
  assertPublicJob(listed.jobs[0])
  const cleared = await requestJson(bridge.baseUrl, '/api/jobs', { method: 'DELETE' })
  assert.deepEqual(cleared.removed, [created.job.id])

  const missing = await requestJson(bridge.baseUrl, '/api/does-not-exist', {}, 404)
  assert.equal(missing.error.code, 'NOT_FOUND')
  console.log('✓ Isolated security, project/asset tiers/package, API, SSE, pixel job, Range, and cleanup')
  failed = false
} finally {
  const logs = bridge.logs()
  await bridge.stop({ keepRuntime: failed })
  if (failed) {
    console.error(`QA runtime retained for inspection: ${bridge.runtimeDirectory}`)
    if (logs.stdout) console.error(logs.stdout)
    if (logs.stderr) console.error(logs.stderr)
  }
}
