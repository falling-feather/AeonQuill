import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'

import { assertCanvasDocument } from '../src/lib/canvasCore.mjs'
import { deserializePixelDocument, serializePixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import {
  assertProjectCatalog,
  createProjectCatalog,
  serializeProjectCatalog,
} from '../src/lib/project/projectCatalog.mjs'
import { assertGenerationPlan, assertStoryProject } from '../src/lib/story/storyProject.mjs'

export const WORKSPACE_STORE_SCHEMA_VERSION = 1
export const SMART_VIDEO_DOCUMENT_SCHEMA_VERSION = 1

const MODE_IDS = new Set(['balanced', 'pixel', 'smart-video'])
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const MAX_MODE_DOCUMENT_BYTES = Object.freeze({
  balanced: 64 * 1024 * 1024,
  pixel: 32 * 1024 * 1024,
  'smart-video': 12 * 1024 * 1024,
})
const AUTO_RECOVERY_INTERVAL_MS = 30_000
const RECOVERY_LIMIT_PER_DOCUMENT = 20

export class WorkspaceStoreError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.name = 'WorkspaceStoreError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function fail(code, message, status = 400, details = undefined) {
  throw new WorkspaceStoreError(code, message, status, details)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function assertId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('INVALID_WORKSPACE_ID', `${label} is invalid`)
  }
  return value
}

function assertModeId(modeId) {
  if (!MODE_IDS.has(modeId)) fail('INVALID_WORKSPACE_MODE', `Unsupported workspace mode: ${String(modeId)}`)
  return modeId
}

function assertRevision(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_WORKSPACE_REVISION', `${label} must be an integer >= 0`)
  return value
}

function parseJsonObject(value, label) {
  if (typeof value !== 'string') fail('INVALID_MODE_DOCUMENT', `${label} must be serialized JSON`)
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    fail('INVALID_MODE_DOCUMENT', `${label} is not valid JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('INVALID_MODE_DOCUMENT', `${label} must be a JSON object`)
  }
  return parsed
}

function assertExactKeys(value, keys, label) {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  const missing = keys.filter((key) => !(key in value))
  if (unknown.length || missing.length) {
    fail('INVALID_MODE_DOCUMENT', `${label} fields do not match the supported schema`, 400, { unknown, missing })
  }
}

function normalizeSmartVideoDocument(value, documentId) {
  const parsed = parseJsonObject(value, 'Smart video document')
  assertExactKeys(parsed, ['schemaVersion', 'project', 'plan'], 'Smart video document')
  if (parsed.schemaVersion !== SMART_VIDEO_DOCUMENT_SCHEMA_VERSION) {
    fail('UNSUPPORTED_MODE_DOCUMENT_SCHEMA', `Unsupported smart video schema: ${String(parsed.schemaVersion)}`, 409)
  }
  let project
  let plan
  try {
    project = assertStoryProject(parsed.project)
    plan = assertGenerationPlan(parsed.plan, project)
  } catch (error) {
    fail(error?.code || 'INVALID_MODE_DOCUMENT', error?.message || 'Smart video document is invalid')
  }
  if (project.id !== documentId || plan.projectId !== documentId) {
    fail('MODE_DOCUMENT_ID_MISMATCH', 'Smart video document id does not match its workspace document')
  }
  return JSON.stringify({
    schemaVersion: SMART_VIDEO_DOCUMENT_SCHEMA_VERSION,
    project,
    plan,
  })
}

function normalizeModeDocument(modeId, value, documentId) {
  const bytes = Buffer.byteLength(typeof value === 'string' ? value : '')
  if (!bytes || bytes > MAX_MODE_DOCUMENT_BYTES[modeId]) {
    fail('MODE_DOCUMENT_SIZE_LIMIT', `Mode document is empty or exceeds ${MAX_MODE_DOCUMENT_BYTES[modeId]} bytes`, 413, {
      bytes,
      maxBytes: MAX_MODE_DOCUMENT_BYTES[modeId],
    })
  }
  if (modeId === 'pixel') {
    let document
    try {
      document = deserializePixelDocument(value)
    } catch (error) {
      fail(error?.code || 'INVALID_MODE_DOCUMENT', error?.message || 'Pixel document is invalid')
    }
    if (document.id !== documentId) fail('MODE_DOCUMENT_ID_MISMATCH', 'Pixel document id does not match its workspace document')
    return serializePixelDocument(document)
  }
  if (modeId === 'smart-video') return normalizeSmartVideoDocument(value, documentId)
  const document = parseJsonObject(value, 'Canvas document')
  try {
    assertCanvasDocument(document)
  } catch (error) {
    fail(error?.code || 'INVALID_MODE_DOCUMENT', error?.message || 'Canvas document is invalid')
  }
  if (document.id !== documentId) fail('MODE_DOCUMENT_ID_MISMATCH', 'Canvas document id does not match its workspace document')
  return JSON.stringify(document)
}

function projectDocument(catalog, projectId, documentId) {
  const project = catalog.projects.find((candidate) => candidate.id === projectId)
  if (!project) fail('WORKSPACE_PROJECT_NOT_FOUND', `Workspace project was not found: ${projectId}`, 404)
  const document = project.documents.find((candidate) => candidate.id === documentId)
  if (!document) fail('WORKSPACE_DOCUMENT_NOT_FOUND', `Workspace document was not found: ${documentId}`, 404)
  return { project, document }
}

function rowToDocument(row) {
  if (!row) return null
  return {
    projectId: row.projectId,
    documentId: row.documentId,
    modeId: row.modeId,
    revision: row.revision,
    value: row.value,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function rowToRecovery(row) {
  return {
    id: row.id,
    projectId: row.projectId,
    documentId: row.documentId || undefined,
    modeId: row.modeId || undefined,
    catalogRevision: row.catalogRevision,
    documentRevision: row.documentRevision ?? undefined,
    reason: row.reason,
    createdAt: row.createdAt,
  }
}

export class WorkspaceStore {
  constructor(rootDirectory) {
    this.rootDirectory = resolve(rootDirectory)
    this.databasePath = join(this.rootDirectory, 'workspace.sqlite3')
    this.database = null
  }

  async open() {
    await mkdir(this.rootDirectory, { recursive: true })
    this.database = new DatabaseSync(this.databasePath)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS workspace_meta (
        key TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mode_documents (
        document_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        mode_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mode_documents_project ON mode_documents(project_id, mode_id, updated_at);
      CREATE TABLE IF NOT EXISTS recovery_points (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        document_id TEXT,
        mode_id TEXT,
        catalog_revision INTEGER NOT NULL,
        document_revision INTEGER,
        project_json TEXT NOT NULL,
        body_json TEXT,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recovery_points_project ON recovery_points(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS recovery_points_document ON recovery_points(document_id, created_at DESC);
    `)
    const existing = this.database.prepare('SELECT key FROM workspace_meta WHERE key = ?').get('project-catalog')
    if (!existing) {
      const now = Date.now()
      this.database.prepare(`
        INSERT INTO workspace_meta (key, schema_version, value_json, updated_at)
        VALUES (?, ?, ?, ?)
      `).run('project-catalog', WORKSPACE_STORE_SCHEMA_VERSION, serializeProjectCatalog(createProjectCatalog()), now)
    }
    return this
  }

  close() {
    this.database?.close()
    this.database = null
  }

  assertOpen() {
    if (!this.database) fail('WORKSPACE_STORE_CLOSED', 'Workspace store is not open', 503)
  }

  getCatalog() {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT value_json AS value, updated_at AS updatedAt
      FROM workspace_meta WHERE key = ?
    `).get('project-catalog')
    if (!row) fail('WORKSPACE_CATALOG_MISSING', 'Workspace catalog metadata is missing', 500)
    let catalog
    try {
      catalog = assertProjectCatalog(JSON.parse(row.value))
    } catch {
      fail('WORKSPACE_CATALOG_CORRUPT', 'Workspace catalog failed strict validation', 500)
    }
    return { catalog, updatedAt: row.updatedAt }
  }

  bootstrapCatalog(catalogInput, options = {}) {
    const current = this.getCatalog()
    const catalog = assertProjectCatalog(catalogInput)
    if (current.catalog.projects.length || current.catalog.revision !== 0 || !catalog.projects.length) return current
    return this.saveCatalog(catalog, {
      baseRevision: 0,
      now: options.now,
      source: options.source || 'legacy-bootstrap',
    })
  }

  saveCatalog(catalogInput, options = {}) {
    this.assertOpen()
    const catalog = assertProjectCatalog(catalogInput)
    const current = this.getCatalog()
    const baseRevision = assertRevision(options.baseRevision, 'baseRevision')
    const serialized = serializeProjectCatalog(catalog)
    const currentSerialized = serializeProjectCatalog(current.catalog)
    if (catalog.revision === current.catalog.revision && serialized === currentSerialized) return current
    if (baseRevision !== current.catalog.revision) {
      fail('WORKSPACE_CATALOG_CONFLICT', `Stored catalog revision ${current.catalog.revision} does not match base ${baseRevision}`, 409, {
        current,
      })
    }
    if (catalog.revision <= current.catalog.revision) {
      fail('WORKSPACE_CATALOG_CONFLICT', 'Workspace catalog revision must advance monotonically', 409, { current })
    }

    const previousOwners = new Map(current.catalog.projects.flatMap((project) =>
      project.documents.map((document) => [document.id, project.id])))
    for (const project of catalog.projects) {
      for (const document of project.documents) {
        const previousOwner = previousOwners.get(document.id)
        if (previousOwner && previousOwner !== project.id) {
          fail('WORKSPACE_DOCUMENT_OWNERSHIP_CHANGE', `Document ${document.id} cannot move between projects`, 409)
        }
      }
    }

    const now = options.now ?? Date.now()
    assertRevision(now, 'now')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const nextProjects = new Map(catalog.projects.map((project) => [project.id, project]))
      for (const project of current.catalog.projects) {
        if (JSON.stringify(project) !== JSON.stringify(nextProjects.get(project.id))) {
          this.insertRecoveryPoint({
            project,
            catalogRevision: current.catalog.revision,
            reason: `catalog-before-${options.source || 'update'}`,
            createdAt: now,
          })
        }
      }
      this.database.prepare(`
        UPDATE workspace_meta SET schema_version = ?, value_json = ?, updated_at = ? WHERE key = ?
      `).run(WORKSPACE_STORE_SCHEMA_VERSION, serialized, now, 'project-catalog')

      const liveDocuments = new Set(catalog.projects.flatMap((project) => project.documents.map((document) => document.id)))
      for (const row of this.database.prepare('SELECT document_id AS documentId FROM mode_documents').all()) {
        if (!liveDocuments.has(row.documentId)) this.database.prepare('DELETE FROM mode_documents WHERE document_id = ?').run(row.documentId)
      }
      const liveProjects = new Set(catalog.projects.map((project) => project.id))
      for (const row of this.database.prepare('SELECT DISTINCT project_id AS projectId FROM recovery_points').all()) {
        if (!liveProjects.has(row.projectId)) this.database.prepare('DELETE FROM recovery_points WHERE project_id = ?').run(row.projectId)
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return { catalog: clone(catalog), updatedAt: now }
  }

  getModeDocument(documentId) {
    this.assertOpen()
    assertId(documentId, 'documentId')
    return rowToDocument(this.database.prepare(`
      SELECT project_id AS projectId, document_id AS documentId, mode_id AS modeId,
             revision, value_json AS value, created_at AS createdAt, updated_at AS updatedAt
      FROM mode_documents WHERE document_id = ?
    `).get(documentId))
  }

  findDocumentRegistration(documentId) {
    this.assertOpen()
    assertId(documentId, 'documentId')
    const catalog = this.getCatalog().catalog
    for (const project of catalog.projects) {
      const document = project.documents.find((candidate) => candidate.id === documentId)
      if (document) return { project: clone(project), document: clone(document) }
    }
    return null
  }

  saveModeDocument(input, options = {}) {
    this.assertOpen()
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_MODE_DOCUMENT_REQUEST', 'Mode document request must be an object')
    const projectId = assertId(input.projectId, 'projectId')
    const documentId = assertId(input.documentId, 'documentId')
    const modeId = assertModeId(input.modeId)
    const revision = assertRevision(input.revision, 'revision')
    const baseRevision = assertRevision(input.baseRevision, 'baseRevision', { nullable: true })
    const catalogRecord = this.getCatalog()
    const { project, document: catalogDocument } = projectDocument(catalogRecord.catalog, projectId, documentId)
    if (catalogDocument.modeId !== modeId) fail('WORKSPACE_MODE_MISMATCH', 'Mode document type does not match the workspace catalog', 409)
    const value = normalizeModeDocument(modeId, input.value, documentId)
    const existing = this.getModeDocument(documentId)
    if (!existing && baseRevision !== null) {
      fail('WORKSPACE_DOCUMENT_CONFLICT', 'A new mode document must use a null base revision', 409)
    }
    if (existing && baseRevision !== existing.revision) {
      if (revision === existing.revision && value === existing.value) return existing
      fail('WORKSPACE_DOCUMENT_CONFLICT', `Stored document revision ${existing.revision} does not match base ${String(baseRevision)}`, 409, {
        current: existing,
      })
    }
    if (existing && revision <= existing.revision) {
      if (revision === existing.revision && value === existing.value) return existing
      fail('WORKSPACE_DOCUMENT_CONFLICT', 'Mode document revision must advance monotonically', 409, { current: existing })
    }

    const now = options.now ?? Date.now()
    assertRevision(now, 'now')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (existing && this.shouldCreateAutoRecovery(documentId, now, options.forceRecovery === true)) {
        this.insertRecoveryPoint({
          project,
          document: existing,
          catalogRevision: catalogRecord.catalog.revision,
          reason: options.reason || 'document-autosave',
          createdAt: now,
        })
      }
      this.database.prepare(`
        INSERT INTO mode_documents
          (document_id, project_id, mode_id, revision, value_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          project_id = excluded.project_id,
          mode_id = excluded.mode_id,
          revision = excluded.revision,
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(documentId, projectId, modeId, revision, value, existing?.createdAt ?? now, now)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.getModeDocument(documentId)
  }

  shouldCreateAutoRecovery(documentId, now, force) {
    if (force) return true
    const row = this.database.prepare(`
      SELECT created_at AS createdAt FROM recovery_points
      WHERE document_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(documentId)
    return !row || now - row.createdAt >= AUTO_RECOVERY_INTERVAL_MS
  }

  insertRecoveryPoint({ project, document, catalogRevision, reason, createdAt }) {
    const id = `recovery-${randomUUID()}`
    this.database.prepare(`
      INSERT INTO recovery_points
        (id, project_id, document_id, mode_id, catalog_revision, document_revision,
         project_json, body_json, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      project.id,
      document?.documentId ?? null,
      document?.modeId ?? null,
      catalogRevision,
      document?.revision ?? null,
      JSON.stringify(project),
      document?.value ?? null,
      String(reason || 'manual').slice(0, 120),
      createdAt,
    )
    const scopeRows = this.database.prepare(`
      SELECT id FROM recovery_points
      WHERE project_id = ? AND document_id IS ?
      ORDER BY created_at DESC, id DESC
    `).all(project.id, document?.documentId ?? null)
    for (const stale of scopeRows.slice(RECOVERY_LIMIT_PER_DOCUMENT)) {
      this.database.prepare('DELETE FROM recovery_points WHERE id = ?').run(stale.id)
    }
    return id
  }

  createRecoveryPoint(projectId, options = {}) {
    this.assertOpen()
    assertId(projectId, 'projectId')
    const current = this.getCatalog()
    const project = current.catalog.projects.find((candidate) => candidate.id === projectId)
    if (!project) fail('WORKSPACE_PROJECT_NOT_FOUND', `Workspace project was not found: ${projectId}`, 404)
    const document = options.documentId ? this.getModeDocument(assertId(options.documentId, 'documentId')) : null
    if (document && document.projectId !== projectId) fail('WORKSPACE_DOCUMENT_OWNERSHIP_CHANGE', 'Recovery document belongs to another project', 409)
    const createdAt = options.now ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const id = this.insertRecoveryPoint({
        project,
        document,
        catalogRevision: current.catalog.revision,
        reason: options.reason || 'manual',
        createdAt,
      })
      this.database.exec('COMMIT')
      return this.getRecoveryPoint(id)
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  getRecoveryPoint(recoveryId) {
    this.assertOpen()
    assertId(recoveryId, 'recoveryId')
    const row = this.database.prepare(`
      SELECT id, project_id AS projectId, document_id AS documentId, mode_id AS modeId,
             catalog_revision AS catalogRevision, document_revision AS documentRevision,
             reason, created_at AS createdAt
      FROM recovery_points WHERE id = ?
    `).get(recoveryId)
    return row ? rowToRecovery(row) : null
  }

  listRecoveryPoints(projectId) {
    this.assertOpen()
    assertId(projectId, 'projectId')
    return this.database.prepare(`
      SELECT id, project_id AS projectId, document_id AS documentId, mode_id AS modeId,
             catalog_revision AS catalogRevision, document_revision AS documentRevision,
             reason, created_at AS createdAt
      FROM recovery_points WHERE project_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(projectId).map(rowToRecovery)
  }

  restoreRecoveryPoint(recoveryId, options = {}) {
    this.assertOpen()
    assertId(recoveryId, 'recoveryId')
    const snapshot = this.database.prepare(`
      SELECT id, project_id AS projectId, document_id AS documentId, mode_id AS modeId,
             catalog_revision AS catalogRevision, document_revision AS documentRevision,
             project_json AS projectJson, body_json AS bodyJson, reason, created_at AS createdAt
      FROM recovery_points WHERE id = ?
    `).get(recoveryId)
    if (!snapshot) fail('RECOVERY_POINT_NOT_FOUND', `Recovery point was not found: ${recoveryId}`, 404)
    const current = this.getCatalog()
    const currentIndex = current.catalog.projects.findIndex((project) => project.id === snapshot.projectId)
    if (currentIndex < 0) fail('WORKSPACE_PROJECT_NOT_FOUND', 'Cannot restore a purged workspace project', 404)
    const now = options.now ?? Date.now()
    const previousProject = current.catalog.projects[currentIndex]
    const restoredProject = JSON.parse(snapshot.projectJson)
    let restoredDocument = null
    if (snapshot.documentId && snapshot.bodyJson !== null) {
      const currentDocument = this.getModeDocument(snapshot.documentId)
      const nextRevision = (currentDocument?.revision ?? snapshot.documentRevision ?? 0) + 1
      const documentIndex = restoredProject.documents.findIndex((document) => document.id === snapshot.documentId)
      if (documentIndex < 0) fail('RECOVERY_POINT_CORRUPT', 'Recovery point document is absent from its project snapshot', 500)
      restoredProject.documents[documentIndex] = {
        ...restoredProject.documents[documentIndex],
        revision: nextRevision,
        updatedAt: now,
      }
      restoredProject.updatedAt = Math.max(restoredProject.updatedAt, now)
      restoredProject.lastOpenedAt = Math.max(restoredProject.lastOpenedAt, now)
      let restoredBody = snapshot.bodyJson
      if (snapshot.modeId === 'balanced' || snapshot.modeId === 'pixel') {
        const parsedBody = parseJsonObject(snapshot.bodyJson, 'Recovery document')
        restoredBody = JSON.stringify({
          ...parsedBody,
          revision: nextRevision,
          ...(snapshot.modeId === 'balanced' ? { updatedAt: now } : {}),
        })
      }
      restoredDocument = {
        projectId: snapshot.projectId,
        documentId: snapshot.documentId,
        modeId: snapshot.modeId,
        revision: nextRevision,
        value: normalizeModeDocument(snapshot.modeId, restoredBody, snapshot.documentId),
        createdAt: currentDocument?.createdAt ?? now,
        updatedAt: now,
      }
    }
    const projects = [...current.catalog.projects]
    projects[currentIndex] = restoredProject
    const catalog = assertProjectCatalog({
      ...current.catalog,
      revision: current.catalog.revision + 1,
      projects,
    })

    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.insertRecoveryPoint({
        project: previousProject,
        document: snapshot.documentId ? this.getModeDocument(snapshot.documentId) : null,
        catalogRevision: current.catalog.revision,
        reason: 'before-recovery-restore',
        createdAt: now,
      })
      this.database.prepare(`
        UPDATE workspace_meta SET value_json = ?, updated_at = ? WHERE key = ?
      `).run(serializeProjectCatalog(catalog), now, 'project-catalog')
      if (restoredDocument) {
        this.database.prepare(`
          INSERT INTO mode_documents
            (document_id, project_id, mode_id, revision, value_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(document_id) DO UPDATE SET
            project_id = excluded.project_id,
            mode_id = excluded.mode_id,
            revision = excluded.revision,
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `).run(
          restoredDocument.documentId,
          restoredDocument.projectId,
          restoredDocument.modeId,
          restoredDocument.revision,
          restoredDocument.value,
          restoredDocument.createdAt,
          restoredDocument.updatedAt,
        )
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return {
      catalog: clone(catalog),
      updatedAt: now,
      document: restoredDocument,
      restoredFrom: rowToRecovery(snapshot),
    }
  }
}
