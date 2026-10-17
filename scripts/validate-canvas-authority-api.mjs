import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProjectCatalog, createWorkspaceProject, touchProjectDocument } from '../src/lib/project/projectCatalog.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

const qaRoot = fileURLToPath(new URL('../.runtime/qa/', import.meta.url))
const bridge = await startIsolatedBridge('canvas-authority')
const report = { schemaVersion: 1, task: 'QA-007 canvas authority and retry', status: 'failed', checks: [] }
let lock
let lockHeld = false
try {
  const now = Date.now()
  const projectId = 'canvas-authority-project', documentId = 'canvas-authority-document'
  const workspace = createWorkspaceProject(createProjectCatalog(), {
    title: 'Canvas authority', initialModeId: 'balanced', color: 'violet',
  }, { projectId, documentId, now })
  const request = async (path, body, method = 'PUT') => {
    const response = await bridge.request(path, { method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, value: await response.json() }
  }
  assert.equal((await request('/api/workspace/catalog', { catalog: workspace.catalog, baseRevision: 0 })).status, 200)
  const initial = { schemaVersion: 1, id: documentId, title: 'Original canvas', revision: 0,
    createdAt: now, updatedAt: now, camera: { x: 0, y: 0, zoom: 1 }, elements: [] }
  assert.equal((await request('/api/projects/current', { document: initial })).status, 200)
  const next = { ...initial, title: 'Retained after SQLite retry', revision: 1, updatedAt: now + 1 }

  const workspacePath = join(bridge.runtimeDirectory, 'workspaces', 'workspace.sqlite3')
  assert.equal((await stat(workspacePath)).isFile(), true)
  lock = new DatabaseSync(workspacePath)
  lock.exec('BEGIN IMMEDIATE')
  lockHeld = true
  const blocked = await request('/api/projects/current', { document: next })
  assert.ok(blocked.status >= 400, 'A failed workspace sync must not return save success')
  const projection = new DatabaseSync(join(bridge.runtimeDirectory, 'projects', 'projects.sqlite3'), { readOnly: true })
  try { assert.equal(projection.prepare('SELECT revision FROM projects WHERE id = ?').get(documentId).revision, 1) }
  finally { projection.close() }
  const during = await request(`/api/projects/current?id=${documentId}`, undefined, 'GET')
  assert.equal(during.value.project.document.revision, 0, 'An uncommitted projection must not replace workspace authority')
  report.checks.push({ case: 'workspace-locked-after-projection-write', status: 'passed', httpStatus: blocked.status,
    projectionRevision: 1, authoritativeRevision: 0, falseSuccess: false })
  lock.exec('ROLLBACK')
  lockHeld = false
  lock.close()
  lock = null

  const retried = await request('/api/projects/current', { document: next })
  assert.equal(retried.status, 200)
  assert.equal(retried.value.project.document.revision, 1)
  const stale = await request('/api/projects/current', { document: initial })
  assert.equal(stale.status, 409)
  assert.equal(stale.value.error.code, 'WORKSPACE_DOCUMENT_CONFLICT')
  await bridge.restart()
  const restored = await request(`/api/projects/current?id=${documentId}`, undefined, 'GET')
  assert.equal(restored.value.project.document.title, next.title)
  assert.equal(restored.value.project.document.revision, 1)
  report.checks.push({ case: 'idempotent-retry-stale-rejection-and-restart', status: 'passed', revision: 1 })

  const catalog = touchProjectDocument(workspace.catalog, projectId, documentId, { title: next.title, revision: 1 })
  assert.equal((await request('/api/workspace/catalog', { catalog, baseRevision: workspace.catalog.revision })).status, 200)
  assert.equal((await request(`/api/workspace/projects/${projectId}/package/preview`, undefined, 'GET')).status, 200)
  report.checks.push({ case: 'existing-client-catalog-flush-contract', status: 'passed', completePackagePreview: true })
  report.status = 'passed'
  console.log('✓ Canvas workspace authority, partial-sync failure, idempotent retry and stale-writer rejection passed')
} catch (error) {
  report.error = { name: error.name, message: error.message }
  throw error
} finally {
  try { if (lockHeld) lock.exec('ROLLBACK') } finally { lock?.close() }
  await bridge.stop()
  await mkdir(qaRoot, { recursive: true })
  await writeFile(join(qaRoot, 'canvas-authority-api.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}
