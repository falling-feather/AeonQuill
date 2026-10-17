import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url))
const tempParent = join(workspaceRoot, '.runtime', 'test-temp')
await mkdir(tempParent, { recursive: true })
const bundleDirectory = await mkdtemp(join(tempParent, 'canvas-project-client-'))
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

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function document(id, revision, title = id) {
  return {
    schemaVersion: 1,
    id,
    title,
    revision,
    createdAt: 1,
    updatedAt: revision + 1,
    elements: [],
    camera: { x: 0, y: 0, zoom: 1 },
  }
}

function storedProject(value, recoveredDraft = false) {
  return {
    id: value.id,
    title: value.title,
    schemaVersion: 1,
    revision: value.revision,
    document: value,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    assets: [],
    assetVersions: [],
    ...(recoveredDraft ? { recoveredDraft: true } : {}),
  }
}

async function loadApi(caseId) {
  const query = '?case=' + caseId + '-' + Date.now() + '-' + Math.random()
  return import(pathToFileURL(bundlePath).href + query)
}

function installFetchMock(t, handler) {
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const pathname = new URL(String(input), 'http://localhost').pathname
    return handler(pathname, options)
  })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('failed local save leaves a recovered draft that load returns without replacing it', async (t) => {
  const api = await loadApi('failed-save-draft')
  const draft = document('client-failed-save', 3)
  const calls = []
  installFetchMock(t, async (pathname, options) => {
    calls.push([pathname, options.method || 'GET'])
    if (pathname === '/api/health') return jsonResponse({ ok: true })
    if (pathname === '/api/projects/current' && options.method === 'PUT') {
      throw new Error('sqlite unavailable')
    }
    throw new Error('unexpected request: ' + pathname)
  })
  await assert.rejects(api.saveLocalProject(draft), /sqlite unavailable/u)
  const recovered = await api.loadLocalProject(draft.id)
  assert.equal(recovered.recoveredDraft, true)
  assert.strictEqual(recovered.document, draft)
  assert.deepEqual(recovered.assets, [])
  assert.deepEqual(recovered.assetVersions, [])
  assert.deepEqual(calls, [
    ['/api/health', 'GET'],
    ['/api/projects/current', 'PUT'],
  ])
})

test('a late GET cannot replace a draft created while the request is in flight', async (t) => {
  const api = await loadApi('late-get-draft')
  const draft = document('client-late-get', 8)
  const lateGet = deferred()
  const putGate = deferred()
  const calls = []
  installFetchMock(t, async (pathname, options) => {
    calls.push([pathname, options.method || 'GET'])
    if (pathname === '/api/health') return jsonResponse({ ok: true })
    if (pathname === '/api/projects/current' && !options.method) return lateGet.promise
    if (pathname === '/api/projects/current' && options.method === 'PUT') {
      await putGate.promise
      return jsonResponse({ project: storedProject(draft) })
    }
    throw new Error('unexpected request: ' + pathname)
  })
  const loading = api.loadLocalProject(draft.id)
  const saving = api.saveLocalProject(draft)
  lateGet.resolve(jsonResponse({ project: storedProject(document(draft.id, 4, 'remote-old')) }))
  const recovered = await loading
  assert.equal(recovered.recoveredDraft, true)
  assert.strictEqual(recovered.document, draft)
  assert.equal(calls.filter(([pathname, method]) => pathname === '/api/projects/current' && method === 'GET').length, 1)
  putGate.resolve()
  await saving
})

test('import waits behind an older save and does not clear a newer draft created while waiting', async (t) => {
  const api = await loadApi('import-order')
  const projectId = 'client-import-order'
  const oldDraft = document(projectId, 2)
  const newDraft = document(projectId, 3)
  let releaseOldSave
  let releaseNewSave
  const oldPutSeen = deferred()
  const oldSaveGate = new Promise((resolve) => { releaseOldSave = resolve })
  const newSaveGate = new Promise((resolve) => { releaseNewSave = resolve })
  const calls = []
  installFetchMock(t, async (pathname, options) => {
    calls.push([pathname, options.method || 'GET'])
    if (pathname === '/api/health') return jsonResponse({ ok: true })
    if (pathname === '/api/projects/current' && options.method === 'PUT') {
      const body = JSON.parse(options.body)
      if (body.document.revision === oldDraft.revision) {
        oldPutSeen.resolve()
        await oldSaveGate
        return jsonResponse({ project: storedProject(oldDraft) })
      }
      await newSaveGate
      return jsonResponse({ project: storedProject(newDraft) })
    }
    if (pathname === '/api/projects/import') {
      return jsonResponse({ project: storedProject(document(projectId, 20, 'imported')) })
    }
    if (pathname === '/api/projects/current' && !options.method) {
      return jsonResponse({ project: storedProject(document(projectId, 20, 'imported')) })
    }
    throw new Error('unexpected request: ' + pathname)
  })

  const oldSave = api.saveLocalProject(oldDraft)
  const imported = api.importLocalProjectPackage(new Blob(['package']), projectId)
  const newSave = api.saveLocalProject(newDraft)
  await oldPutSeen.promise
  assert.deepEqual(calls.filter(([, method]) => method === 'PUT' || method === 'POST'), [
    ['/api/projects/current', 'PUT'],
  ])
  releaseOldSave()
  const importedProject = await imported
  assert.equal(importedProject.document.title, 'imported')
  assert.deepEqual(calls.filter(([, method]) => method === 'PUT' || method === 'POST'), [
    ['/api/projects/current', 'PUT'],
    ['/api/projects/import', 'POST'],
  ])

  const recoveredDuringNewSave = await api.loadLocalProject(projectId)
  assert.equal(recoveredDuringNewSave.recoveredDraft, true)
  assert.strictEqual(recoveredDuringNewSave.document, newDraft)
  releaseNewSave()
  await oldSave
  await newSave
  const remote = await api.loadLocalProject(projectId)
  assert.equal(remote.recoveredDraft, undefined)
  assert.equal(remote.document.title, 'imported')
})

test('failed import preserves the pre-import draft', async (t) => {
  const api = await loadApi('import-failure')
  const projectId = 'client-import-failure'
  const draft = document(projectId, 5)
  installFetchMock(t, async (pathname, options) => {
    if (pathname === '/api/health') return jsonResponse({ ok: true })
    if (pathname === '/api/projects/current' && options.method === 'PUT') {
      throw new Error('sqlite unavailable')
    }
    if (pathname === '/api/projects/import') return jsonResponse({ error: { message: '坏项目包' } }, 409)
    throw new Error('unexpected request: ' + pathname + ' ' + (options.method || 'GET'))
  })
  await assert.rejects(api.saveLocalProject(draft), /sqlite unavailable/u)
  await assert.rejects(api.importLocalProjectPackage(new Blob(['bad']), projectId), /坏项目包/u)
  const recovered = await api.loadLocalProject(projectId)
  assert.equal(recovered.recoveredDraft, true)
  assert.strictEqual(recovered.document, draft)
})
