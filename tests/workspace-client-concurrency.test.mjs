import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url))
const tempParent = join(workspaceRoot, '.runtime', 'test-temp')
await mkdir(tempParent, { recursive: true })
const bundleDirectory = await mkdtemp(join(tempParent, 'workspace-client-'))
const bundlePath = join(bundleDirectory, 'projectApi.mjs')
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/projectApi.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
await writeFile(bundlePath, bundled.outputFiles[0].text, 'utf8')

test.after(async () => {
  await rm(bundleDirectory, { recursive: true, force: true })
})

function deferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function document(revision, value = `remote-${revision}`) {
  return {
    projectId: 'project-1', documentId: 'document-1', modeId: 'balanced', revision,
    value, createdAt: 1, updatedAt: revision,
  }
}

async function loadApi(caseId) {
  return import(`${pathToFileURL(bundlePath).href}?case=${caseId}-${Date.now()}-${Math.random()}`)
}

function installFetchMock(t, handler) {
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const pathname = new URL(String(input), 'http://localhost').pathname
    if (pathname === '/api/health') return jsonResponse({ ok: true })
    return handler(pathname, options)
  })
}

test('large workspace uploads use a reusable Blob with exact JSON UTF-8 bytes and revision semantics', async (t) => {
  const api = await loadApi('large-utf8-upload')
  const value = '像素🙂\\n"'.repeat(180_000)
  let writes = 0
  installFetchMock(t, async (pathname, options) => {
    if (options.method === undefined) return jsonResponse({ document: document(7) })
    assert.equal(pathname, '/api/workspace/documents/document-1')
    assert.equal(options.method, 'PUT')
    assert.equal(options.body instanceof Blob, true)
    const expected = JSON.stringify({ projectId: 'project-1', modeId: 'balanced', revision: 8, value, reason: 'large-autosave', baseRevision: 7 })
    const expectedBytes = Buffer.from(expected, 'utf8')
    assert.equal(options.body.size, expectedBytes.byteLength)
    assert.equal(options.body.type, 'application/json')
    const actualBytes = new Uint8Array(await options.body.arrayBuffer())
    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
    assert.equal(digest(actualBytes), digest(expectedBytes))
    assert.equal(digest(new Uint8Array(await options.body.arrayBuffer())), digest(expectedBytes))
    assert.equal(options.headers['content-type'], 'application/json')
    writes += 1
    return jsonResponse({ document: document(8, value) })
  })
  await api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  const saved = await api.saveWorkspaceModeDocument({ projectId: 'project-1', documentId: 'document-1', modeId: 'balanced', revision: 8, value, reason: 'large-autosave' })
  assert.equal(writes, 1)
  assert.equal(saved.value, value)
  assert.equal(saved.revision, 8)
})

test('late read after a failed write cannot replace the retry base revision', async (t) => {
  const api = await loadApi('late-read-after-failed-write')
  const firstPutSeen = deferred()
  const failedPut = deferred()
  const lateReadResponse = deferred()
  const puts = []
  let documentReads = 0
  installFetchMock(t, async (pathname, options) => {
    if (pathname.startsWith('/api/workspace/documents/document-1') && options.method === undefined) {
      documentReads += 1
      if (documentReads === 1) return jsonResponse({ document: document(1) })
      return lateReadResponse.promise
    }
    if (pathname === '/api/workspace/documents/document-1' && options.method === 'PUT') {
      puts.push(JSON.parse(options.body))
      if (puts.length === 1) {
        firstPutSeen.resolve()
        return failedPut.promise
      }
      return jsonResponse({ document: document(3, 'retry-success') })
    }
    throw new Error(`unexpected request ${pathname} ${options.method || 'GET'}`)
  })

  await api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  const failedSave = api.saveWorkspaceModeDocument({
    projectId: 'project-1', documentId: 'document-1', modeId: 'balanced', revision: 1, value: 'draft',
  })
  await firstPutSeen.promise
  const lateRead = api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  failedPut.reject(new Error('write failed'))
  await assert.rejects(failedSave, /write failed/u)
  lateReadResponse.resolve(jsonResponse({ document: document(2, 'remote-newer') }))
  await lateRead

  await api.saveWorkspaceModeDocument({
    projectId: 'project-1', documentId: 'document-1', modeId: 'balanced', revision: 1, value: 'retry',
  })
  assert.equal(puts[1].baseRevision, 1)
})

test('a read started after a failed write stays dirty and cannot advance the base revision', async (t) => {
  const api = await loadApi('read-after-failed-write')
  const failedPut = deferred()
  const puts = []
  let reads = 0
  installFetchMock(t, async (pathname, options) => {
    if (pathname.startsWith('/api/workspace/documents/document-1') && options.method === undefined) {
      reads += 1
      return jsonResponse({ document: document(reads === 1 ? 1 : 2) })
    }
    if (pathname === '/api/workspace/documents/document-1' && options.method === 'PUT') {
      puts.push(JSON.parse(options.body))
      if (puts.length === 1) return failedPut.promise
      return jsonResponse({ document: document(3) })
    }
    throw new Error(`unexpected request ${pathname} ${options.method || 'GET'}`)
  })

  await api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  const failedSave = api.saveWorkspaceModeDocument({
    projectId: 'project-1', documentId: 'document-1', modeId: 'balanced', revision: 1, value: 'draft',
  })
  failedPut.reject(new Error('write failed'))
  await assert.rejects(failedSave, /write failed/u)
  await api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  await api.saveWorkspaceModeDocument({
    projectId: 'project-1', documentId: 'document-1', modeId: 'balanced', revision: 1, value: 'retry',
  })
  assert.equal(puts[1].baseRevision, 1)
})

test('a clean read after a successful write may adopt the newer remote revision', async (t) => {
  const api = await loadApi('clean-read-after-success')
  const puts = []
  let reads = 0
  installFetchMock(t, async (pathname, options) => {
    if (pathname.startsWith('/api/workspace/documents/document-1') && options.method === undefined) {
      reads += 1
      return jsonResponse({ document: document(reads === 1 ? 1 : 3) })
    }
    if (pathname === '/api/workspace/documents/document-1' && options.method === 'PUT') {
      puts.push(JSON.parse(options.body))
      return jsonResponse({ document: document(2, 'saved') })
    }
    throw new Error(`unexpected request ${pathname} ${options.method || 'GET'}`)
  })

  await api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  await api.saveWorkspaceModeDocument({
    projectId: 'project-1', documentId: 'document-1', modeId: 'balanced', revision: 1, value: 'saved',
  })
  await api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  await api.saveWorkspaceModeDocument({
    projectId: 'project-1', documentId: 'document-1', modeId: 'balanced', revision: 3, value: 'next',
  })
  assert.equal(puts[1].baseRevision, 3)
})

test('an older clean read returning after a newer clean read cannot roll the base revision back', async (t) => {
  const api = await loadApi('out-of-order-clean-reads')
  const oldReadSeen = deferred()
  const newReadSeen = deferred()
  const oldReadResponse = deferred()
  const newReadResponse = deferred()
  const puts = []
  let reads = 0
  installFetchMock(t, async (pathname, options) => {
    if (pathname.startsWith('/api/workspace/documents/document-1') && options.method === undefined) {
      reads += 1
      if (reads === 1) return jsonResponse({ document: document(0, 'initial') })
      if (reads === 2) {
        oldReadSeen.resolve()
        return oldReadResponse.promise
      }
      newReadSeen.resolve()
      return newReadResponse.promise
    }
    if (pathname === '/api/workspace/documents/document-1' && options.method === 'PUT') {
      puts.push(JSON.parse(options.body))
      return jsonResponse({ document: document(3, 'saved-from-rev2') })
    }
    throw new Error(`unexpected request ${pathname} ${options.method || 'GET'}`)
  })

  await api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  const olderRead = api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  await oldReadSeen.promise
  const newerRead = api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  await newReadSeen.promise
  newReadResponse.resolve(jsonResponse({ document: document(2, 'newer') }))
  await newerRead
  oldReadResponse.resolve(jsonResponse({ document: document(1, 'older') }))
  await olderRead

  await api.saveWorkspaceModeDocument({
    projectId: 'project-1', documentId: 'document-1', modeId: 'balanced', revision: 2, value: 'save-from-newer',
  })
  assert.equal(puts[0].baseRevision, 2)
})

test('restore waits for queued writes and invalidates a late read before the next write', async (t) => {
  const api = await loadApi('restore-waits-for-write')
  const firstPutSeen = deferred()
  const firstPutResponse = deferred()
  const lateReadResponse = deferred()
  const puts = []
  let reads = 0
  let restoreCalls = 0
  let restoreRequestPayload = null
  installFetchMock(t, async (pathname, options) => {
    if (pathname.startsWith('/api/workspace/documents/document-1') && options.method === undefined) {
      reads += 1
      if (reads === 1) return jsonResponse({ document: document(1) })
      return lateReadResponse.promise
    }
    if (pathname === '/api/workspace/documents/document-1' && options.method === 'PUT') {
      puts.push(JSON.parse(options.body))
      if (puts.length === 1) {
        firstPutSeen.resolve()
        return firstPutResponse.promise
      }
      return jsonResponse({ document: document(11, 'after-restore') })
    }
    if (pathname === '/api/workspace/recovery-points/rp/restore' && options.method === 'POST') {
      restoreCalls += 1
      restoreRequestPayload = {
        restored: {
          catalog: { projects: [] }, updatedAt: 10, document: document(10, 'restored'),
          restoredFrom: { id: 'rp', projectId: 'project-1', documentId: 'document-1', catalogRevision: 10, reason: 'test', createdAt: 1 },
        },
      }
      return jsonResponse(restoreRequestPayload)
    }
    throw new Error(`unexpected request ${pathname} ${options.method || 'GET'}`)
  })

  await api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  const lateRead = api.loadWorkspaceModeDocument('project-1', 'document-1', 'balanced')
  const save = api.saveWorkspaceModeDocument({
    projectId: 'project-1', documentId: 'document-1', modeId: 'balanced', revision: 1, value: 'before-restore',
  })
  await firstPutSeen.promise
  const restore = api.restoreWorkspaceRecoveryPoint('rp')
  await Promise.resolve()
  assert.equal(restoreCalls, 0)
  firstPutResponse.resolve(jsonResponse({ document: document(2, 'saved-before-restore') }))
  await save
  const restored = await restore
  assert.deepEqual(restored, restoreRequestPayload)
  assert.equal(restored.restored.document.revision, 10)
  lateReadResponse.resolve(jsonResponse({ document: document(9, 'late-old-read') }))
  await lateRead

  await api.saveWorkspaceModeDocument({
    projectId: 'project-1', documentId: 'document-1', modeId: 'balanced', revision: 10, value: 'after-restore',
  })
  assert.equal(puts[1].baseRevision, 10)
})
