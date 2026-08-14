import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { basename, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'
import { assertCanvasDocument } from '../src/lib/canvasCore.mjs'

const PROJECT_SCHEMA_VERSION = 1
const PACKAGE_SCHEMA_VERSION = 1
const MAX_PROJECT_BYTES = 64 * 1024 * 1024
const MAX_ASSET_BYTES = 256 * 1024 * 1024
const MAX_PACKAGE_BYTES = 384 * 1024 * 1024
const ASSET_ID_PATTERN = /^[a-f0-9]{64}$/
const ASSET_VERSION_ID_PATTERN = /^asset-version-[a-f0-9]{32}$/
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/
const MIME_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['video/mp4', 'mp4'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
])
const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export class ProjectStoreError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.name = 'ProjectStoreError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function fail(code, message, status, details) {
  throw new ProjectStoreError(code, message, status, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    fail('INVALID_PROJECT_ID', 'Project id is invalid', 400)
  }
}

function assertAssetId(assetId) {
  if (typeof assetId !== 'string' || !ASSET_ID_PATTERN.test(assetId)) {
    fail('INVALID_ASSET_ID', 'Asset id is invalid', 400)
  }
}

function stableJson(value) {
  return JSON.stringify(value)
}

export function contentHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function pathWithin(root, candidate) {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  if (absoluteCandidate !== absoluteRoot && !absoluteCandidate.startsWith(`${absoluteRoot}${sep}`)) {
    fail('UNSAFE_PATH', 'Managed project path escaped its root', 500)
  }
  return absoluteCandidate
}

function assetFilename(assetId, extension) {
  return `${assetId}.${extension}`
}

export function assetVersionId(logicalAssetId, version, assetId) {
  const digest = contentHash(Buffer.from(`${logicalAssetId}\0${version}\0${assetId}`, 'utf8'))
  return `asset-version-${digest.slice(0, 32)}`
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function collectAssetCandidates(value, candidates, path = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectAssetCandidates(item, candidates, [...path, index], seen))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key]
    if (typeof child === 'string' && /^data:(image\/(?:png|jpeg|webp)|video\/mp4|audio\/(?:mpeg|wav));base64,/i.test(child)) {
      candidates.push({ path: nextPath, kind: 'data-url', source: child })
    } else if (typeof child === 'string' && /^\/(?:api\/assets|assets|src\/assets)\/[a-zA-Z0-9._%-]+$/.test(child)) {
      candidates.push({ path: nextPath, kind: 'managed-reference', source: child })
    } else {
      collectAssetCandidates(child, candidates, nextPath, seen)
    }
  }
}

function decodeSupportedDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(dataUrl)
  if (!match) fail('INVALID_ASSET_DATA', 'Embedded asset must be a supported base64 data URL', 400)
  const mimeType = match[1].toLowerCase()
  const extension = MIME_EXTENSIONS.get(mimeType)
  if (!extension) fail('UNSUPPORTED_ASSET_TYPE', `Unsupported embedded asset type: ${mimeType}`, 415)
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES) {
    fail('ASSET_SIZE_LIMIT', 'Embedded asset is empty or exceeds the asset size limit', 413)
  }
  return { mimeType, extension, bytes }
}

function setAtPath(root, path, value) {
  let target = root
  for (let index = 0; index < path.length - 1; index += 1) target = target[path[index]]
  target[path.at(-1)] = value
}

function collectAssetIds(value, ids = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return ids
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectAssetIds(item, ids, seen)
    return ids
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'assetId' || key === 'sourceAssetId') && typeof child === 'string' && ASSET_ID_PATTERN.test(child)) {
      ids.add(child)
    }
    if (typeof child === 'string') {
      const managed = /^\/api\/project-assets\/([a-f0-9]{64})$/.exec(child)
      if (managed) ids.add(managed[1])
    }
    collectAssetIds(child, ids, seen)
  }
  return ids
}

function exportAssetPath(assetId, asset) {
  return `assets/${assetFilename(assetId, asset.extension)}`
}

export class ProjectStore {
  constructor(rootDirectory) {
    this.rootDirectory = resolve(rootDirectory)
    this.databasePath = join(this.rootDirectory, 'projects.sqlite3')
    this.assetDirectory = join(this.rootDirectory, 'assets')
    this.tempDirectory = join(this.rootDirectory, 'tmp')
    this.database = null
  }

  async open() {
    await Promise.all([
      mkdir(this.rootDirectory, { recursive: true }),
      mkdir(this.assetDirectory, { recursive: true }),
      mkdir(this.tempDirectory, { recursive: true }),
    ])
    this.database = new DatabaseSync(this.databasePath)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        extension TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        provenance_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_assets (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
        role TEXT NOT NULL DEFAULT 'document',
        PRIMARY KEY (project_id, asset_id)
      );
      CREATE TABLE IF NOT EXISTS asset_versions (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        logical_asset_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
        parent_version_id TEXT,
        source_element_id TEXT,
        provenance_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, id),
        UNIQUE (project_id, logical_asset_id, version)
      );
      CREATE INDEX IF NOT EXISTS project_assets_asset_id ON project_assets(asset_id);
      CREATE INDEX IF NOT EXISTS asset_versions_asset_id ON asset_versions(asset_id);
      CREATE INDEX IF NOT EXISTS asset_versions_logical ON asset_versions(project_id, logical_asset_id, version);
    `)
    return this
  }

  close() {
    this.database?.close()
    this.database = null
  }

  assertOpen() {
    if (!this.database) fail('PROJECT_STORE_CLOSED', 'Project store is not open', 503)
  }

  assetPath(asset) {
    const relativePath = asset.relativePath ?? asset.relative_path
    return pathWithin(this.assetDirectory, join(this.assetDirectory, basename(relativePath)))
  }

  getProject(projectId) {
    this.assertOpen()
    assertProjectId(projectId)
    const row = this.database.prepare(`
      SELECT id, title, schema_version AS schemaVersion, revision, document_json AS documentJson,
             created_at AS createdAt, updated_at AS updatedAt
      FROM projects WHERE id = ?
    `).get(projectId)
    if (!row) return null
    return {
      id: row.id,
      title: row.title,
      schemaVersion: row.schemaVersion,
      revision: row.revision,
      document: JSON.parse(row.documentJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      assets: this.listProjectAssets(projectId),
      assetVersions: this.listProjectAssetVersions(projectId),
    }
  }

  listProjectAssets(projectId) {
    this.assertOpen()
    assertProjectId(projectId)
    return this.database.prepare(`
      SELECT DISTINCT a.id, a.mime_type AS mimeType, a.extension, a.bytes,
             a.provenance_json AS provenanceJson, a.created_at AS createdAt
      FROM assets a
      WHERE EXISTS (
        SELECT 1 FROM project_assets pa WHERE pa.asset_id = a.id AND pa.project_id = ?
      ) OR EXISTS (
        SELECT 1 FROM asset_versions av WHERE av.asset_id = a.id AND av.project_id = ?
      )
      ORDER BY a.created_at ASC, a.id ASC
    `).all(projectId, projectId).map((row) => ({
      id: row.id,
      mimeType: row.mimeType,
      extension: row.extension,
      bytes: row.bytes,
      provenance: JSON.parse(row.provenanceJson),
      createdAt: row.createdAt,
      url: `/api/project-assets/${row.id}`,
    }))
  }

  listProjectAssetVersions(projectId) {
    this.assertOpen()
    assertProjectId(projectId)
    return this.database.prepare(`
      SELECT id, logical_asset_id AS logicalAssetId, version, asset_id AS assetId,
             parent_version_id AS parentVersionId, source_element_id AS sourceElementId,
             provenance_json AS provenanceJson, created_at AS createdAt
      FROM asset_versions
      WHERE project_id = ?
      ORDER BY logical_asset_id ASC, version ASC, id ASC
    `).all(projectId).map((row) => ({
      id: row.id,
      logicalAssetId: row.logicalAssetId,
      version: row.version,
      assetId: row.assetId,
      parentVersionId: row.parentVersionId || undefined,
      sourceElementId: row.sourceElementId || undefined,
      provenance: JSON.parse(row.provenanceJson),
      createdAt: row.createdAt,
    }))
  }

  getAsset(assetId) {
    this.assertOpen()
    assertAssetId(assetId)
    const row = this.database.prepare(`
      SELECT id, sha256, mime_type AS mimeType, extension, bytes,
             relative_path AS relativePath, provenance_json AS provenanceJson, created_at AS createdAt
      FROM assets WHERE id = ?
    `).get(assetId)
    return row ? { ...row, provenance: JSON.parse(row.provenanceJson) } : null
  }

  async prepareDocument(document, options = {}) {
    try {
      assertCanvasDocument(document)
    } catch (error) {
      fail(error.code || 'INVALID_PROJECT_DOCUMENT', error.message || 'Project document is invalid', 400)
    }
    const projectId = document.id
    assertProjectId(projectId)
    if (document.schemaVersion !== PROJECT_SCHEMA_VERSION || !Array.isArray(document.elements) || !isRecord(document.camera)) {
      fail('UNSUPPORTED_PROJECT_SCHEMA', 'Only CanvasDocument schema v1 can be saved', 409)
    }
    const serialized = stableJson(document)
    if (Buffer.byteLength(serialized) > MAX_PROJECT_BYTES) fail('PROJECT_SIZE_LIMIT', 'Project document exceeds 64MB', 413)

    const normalized = cloneJson(document)
    const candidates = []
    collectAssetCandidates(normalized, candidates)
    const stagedAssets = new Map()
    for (const candidate of candidates) {
      const decoded = candidate.kind === 'data-url'
        ? decodeSupportedDataUrl(candidate.source)
        : await options.resolveAssetReference?.(candidate.source)
      if (!decoded) fail('ASSET_NOT_FOUND', `Managed project asset was not found: ${candidate.source}`, 409)
      if (!Buffer.isBuffer(decoded.bytes) || !decoded.bytes.length || decoded.bytes.length > MAX_ASSET_BYTES) {
        fail('ASSET_SIZE_LIMIT', 'Managed asset is empty or exceeds the asset size limit', 413)
      }
      if (!MIME_EXTENSIONS.has(decoded.mimeType) || MIME_EXTENSIONS.get(decoded.mimeType) !== decoded.extension) {
        fail('UNSUPPORTED_ASSET_TYPE', `Unsupported managed asset type: ${decoded.mimeType}`, 415)
      }
      const assetId = contentHash(decoded.bytes)
      stagedAssets.set(assetId, {
        id: assetId,
        sha256: assetId,
        ...decoded,
        provenance: {
          source: candidate.kind === 'data-url' ? 'embedded-data-url' : candidate.source,
          importedAt: options.importedAt || Date.now(),
          sourceElementId: typeof candidate.path[1] === 'number'
            ? normalized.elements?.[candidate.path[1]]?.id
            : undefined,
        },
      })
      setAtPath(normalized, candidate.path, `/api/project-assets/${assetId}`)
    }
    const assetVersionsById = new Map()
    const elementsById = new Map(normalized.elements.map((element) => [element.id, element]))
    for (const element of normalized.elements) {
      const renderedReference = element.kind === 'video' ? element.videoSrc : element.src
      const match = /^\/api\/project-assets\/([a-f0-9]{64})$/.exec(renderedReference || '')
      if (!match) continue
      const contentAssetId = match[1]
      const logicalAssetId = typeof element.assetId === 'string' && element.assetId && !ASSET_ID_PATTERN.test(element.assetId)
        ? element.assetId
        : `asset-${element.id}`
      const version = Number.isSafeInteger(element.assetVersion) && element.assetVersion > 0
        ? element.assetVersion
        : 1
      const versionId = assetVersionId(logicalAssetId, version, contentAssetId)
      element.assetId = logicalAssetId
      element.assetVersion = version
      element.assetVersionId = versionId
      const asset = stagedAssets.get(contentAssetId) || this.getAsset(contentAssetId)
      assetVersionsById.set(versionId, {
        id: versionId,
        logicalAssetId,
        version,
        assetId: contentAssetId,
        sourceElementId: element.sourceElementId,
        provenance: {
          ...(asset?.provenance || {}),
          sourceElementId: element.sourceElementId,
          jobId: element.jobId,
          operation: element.processingStack?.at(-1)?.type,
        },
      })
    }
    for (const versionRecord of assetVersionsById.values()) {
      const source = versionRecord.sourceElementId
        ? elementsById.get(versionRecord.sourceElementId)
        : null
      if (source?.assetVersionId) {
        versionRecord.parentVersionId = source.assetVersionId
      } else if (versionRecord.version > 1) {
        const previous = this.database.prepare(`
          SELECT id FROM asset_versions
          WHERE project_id = ? AND logical_asset_id = ? AND version = ?
        `).get(projectId, versionRecord.logicalAssetId, versionRecord.version - 1)
        if (previous?.id) versionRecord.parentVersionId = previous.id
      }
    }
    const referencedAssetIds = collectAssetIds(normalized)
    try {
      assertCanvasDocument(normalized)
    } catch (error) {
      fail(error.code || 'INVALID_PROJECT_DOCUMENT', error.message || 'Normalized project document is invalid', 400)
    }
    return {
      document: normalized,
      stagedAssets,
      referencedAssetIds,
      assetVersions: [...assetVersionsById.values()],
    }
  }

  async saveProject(document, options = {}) {
    this.assertOpen()
    const now = options.now ?? Date.now()
    const prepared = await this.prepareDocument(document, {
      importedAt: now,
      resolveAssetReference: options.resolveAssetReference,
    })
    const existing = this.getProject(document.id)
    if (existing && document.revision < existing.revision) {
      fail('PROJECT_REVISION_CONFLICT', `Stored revision ${existing.revision} is newer than ${document.revision}`, 409)
    }
    if (
      existing &&
      document.revision === existing.revision &&
      stableJson(prepared.document) !== stableJson(existing.document)
    ) {
      fail('PROJECT_REVISION_CONFLICT', `Revision ${document.revision} already contains different project data`, 409)
    }

    for (const versionRecord of prepared.assetVersions) {
      const existingVersion = this.database.prepare(`
        SELECT id, asset_id AS assetId FROM asset_versions
        WHERE project_id = ? AND logical_asset_id = ? AND version = ?
      `).get(prepared.document.id, versionRecord.logicalAssetId, versionRecord.version)
      if (existingVersion && existingVersion.assetId !== versionRecord.assetId) {
        fail(
          'ASSET_VERSION_CONFLICT',
          `Asset ${versionRecord.logicalAssetId} version ${versionRecord.version} already has different content`,
          409,
        )
      }
    }

    const projectAssetIds = new Set([
      ...prepared.referencedAssetIds,
      ...prepared.stagedAssets.keys(),
      ...prepared.assetVersions.map((version) => version.assetId),
    ])
    for (const assetId of projectAssetIds) {
      if (!prepared.stagedAssets.has(assetId) && !this.getAsset(assetId)) {
        fail('ASSET_NOT_FOUND', `Referenced asset does not exist: ${assetId}`, 409)
      }
    }

    const createdFiles = []
    for (const asset of prepared.stagedAssets.values()) {
      const existingAsset = this.getAsset(asset.id)
      if (existingAsset) continue
      const relativePath = assetFilename(asset.id, asset.extension)
      const finalPath = pathWithin(this.assetDirectory, join(this.assetDirectory, relativePath))
      const temporaryPath = pathWithin(this.tempDirectory, join(this.tempDirectory, `${asset.id}-${randomUUID()}.tmp`))
      await writeFile(temporaryPath, asset.bytes, { flag: 'wx' })
      try {
        await rename(temporaryPath, finalPath)
        createdFiles.push(finalPath)
      } catch (error) {
        await unlink(temporaryPath).catch(() => {})
        if (error.code !== 'EEXIST') throw error
      }
    }

    try {
      this.database.exec('BEGIN IMMEDIATE')
      const insertAsset = this.database.prepare(`
        INSERT OR IGNORE INTO assets
          (id, sha256, mime_type, extension, bytes, relative_path, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const asset of prepared.stagedAssets.values()) {
        insertAsset.run(
          asset.id,
          asset.sha256,
          asset.mimeType,
          asset.extension,
          asset.bytes.length,
          assetFilename(asset.id, asset.extension),
          stableJson(asset.provenance),
          now,
        )
      }
      this.database.prepare(`
        INSERT INTO projects (id, title, schema_version, revision, document_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          schema_version = excluded.schema_version,
          revision = excluded.revision,
          document_json = excluded.document_json,
          updated_at = excluded.updated_at
      `).run(
        prepared.document.id,
        String(prepared.document.title || '光阴砚画布'),
        PROJECT_SCHEMA_VERSION,
        prepared.document.revision,
        stableJson(prepared.document),
        existing?.createdAt || now,
        now,
      )
      const insertVersion = this.database.prepare(`
        INSERT OR IGNORE INTO asset_versions
          (project_id, id, logical_asset_id, version, asset_id, parent_version_id,
           source_element_id, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const versionRecord of prepared.assetVersions) {
        insertVersion.run(
          prepared.document.id,
          versionRecord.id,
          versionRecord.logicalAssetId,
          versionRecord.version,
          versionRecord.assetId,
          versionRecord.parentVersionId || null,
          versionRecord.sourceElementId || null,
          stableJson(versionRecord.provenance),
          now,
        )
      }
      this.database.prepare('DELETE FROM project_assets WHERE project_id = ?').run(prepared.document.id)
      const linkAsset = this.database.prepare(`
        INSERT INTO project_assets (project_id, asset_id, role) VALUES (?, ?, 'document')
      `)
      for (const assetId of projectAssetIds) linkAsset.run(prepared.document.id, assetId)
      this.database.exec('COMMIT')
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch {}
      for (const filePath of createdFiles) await unlink(filePath).catch(() => {})
      throw error
    }
    return this.getProject(prepared.document.id)
  }

  async deleteProject(projectId) {
    this.assertOpen()
    assertProjectId(projectId)
    const result = this.database.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    return Number(result.changes) > 0
  }

  async collectGarbage() {
    this.assertOpen()
    const trashDirectory = join(this.rootDirectory, 'trash')
    await mkdir(trashDirectory, { recursive: true })
    const orphans = this.database.prepare(`
      SELECT a.id, a.relative_path AS relativePath
      FROM assets a
      WHERE NOT EXISTS (SELECT 1 FROM project_assets pa WHERE pa.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM asset_versions av WHERE av.asset_id = a.id)
    `).all()
    const removed = []
    for (const asset of orphans) {
      const filePath = this.assetPath(asset)
      const trashPath = pathWithin(trashDirectory, join(trashDirectory, `${asset.id}-${randomUUID()}.trash`))
      let moved = false
      try {
        await rename(filePath, trashPath)
        moved = true
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      try {
        this.database.exec('BEGIN IMMEDIATE')
        const stillReferenced = this.database.prepare(`
          SELECT 1 AS found
          WHERE EXISTS (SELECT 1 FROM project_assets WHERE asset_id = ?)
             OR EXISTS (SELECT 1 FROM asset_versions WHERE asset_id = ?)
        `).get(asset.id, asset.id)
        if (stillReferenced) {
          this.database.exec('ROLLBACK')
          if (moved) await rename(trashPath, filePath)
          continue
        }
        this.database.prepare('DELETE FROM assets WHERE id = ?').run(asset.id)
        this.database.exec('COMMIT')
        removed.push(asset.id)
        if (moved) await unlink(trashPath).catch(() => {})
      } catch (error) {
        try { this.database.exec('ROLLBACK') } catch {}
        if (moved) await rename(trashPath, filePath).catch(() => {})
        throw error
      }
    }
    return removed
  }

  async exportProject(projectId, destinationPath) {
    this.assertOpen()
    const project = this.getProject(projectId)
    if (!project) fail('PROJECT_NOT_FOUND', 'Project was not found', 404)
    const directory = resolve(destinationPath)
    await mkdir(directory, { recursive: true })
    const assetsDirectory = join(directory, 'assets')
    await mkdir(assetsDirectory, { recursive: true })
    const manifest = {
      packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
      exportedAt: Date.now(),
      project: {
        id: project.id,
        title: project.title,
        schemaVersion: project.schemaVersion,
        revision: project.revision,
        documentPath: 'document.json',
      },
      assetVersions: project.assetVersions,
      assets: [],
    }
    await writeFile(join(directory, 'document.json'), JSON.stringify(project.document, null, 2), 'utf8')
    for (const assetSummary of project.assets) {
      const asset = this.getAsset(assetSummary.id)
      const relativePath = exportAssetPath(asset.id, asset)
      await copyFile(this.assetPath(asset), join(directory, ...relativePath.split('/')))
      manifest.assets.push({
        id: asset.id,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
        path: relativePath,
        provenance: asset.provenance,
      })
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return manifest
  }

  async exportProjectBundle(projectId) {
    this.assertOpen()
    const project = this.getProject(projectId)
    if (!project) fail('PROJECT_NOT_FOUND', 'Project was not found', 404)
    const payload = {
      packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
      exportedAt: Date.now(),
      project: {
        id: project.id,
        title: project.title,
        schemaVersion: project.schemaVersion,
        revision: project.revision,
        document: project.document,
        assetVersions: project.assetVersions,
      },
      assets: [],
    }
    for (const summary of project.assets) {
      const asset = this.getAsset(summary.id)
      const bytes = await readFile(this.assetPath(asset))
      if (contentHash(bytes) !== asset.sha256) {
        fail('ASSET_HASH_MISMATCH', `Stored asset hash mismatch: ${asset.id}`, 409)
      }
      payload.assets.push({
        id: asset.id,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
        provenance: asset.provenance,
        dataBase64: bytes.toString('base64'),
      })
    }
    const encoded = Buffer.from(stableJson(payload), 'utf8')
    if (encoded.length > MAX_PACKAGE_BYTES) fail('PROJECT_PACKAGE_LIMIT', 'Project package exceeds 384MB', 413)
    return gzipAsync(encoded, { level: 6 })
  }

  async importProjectBundle(bundle, options = {}) {
    this.assertOpen()
    if (!Buffer.isBuffer(bundle) || !bundle.length || bundle.length > MAX_PACKAGE_BYTES) {
      fail('PROJECT_PACKAGE_LIMIT', 'Project package is empty or exceeds 384MB', 413)
    }
    let decoded
    try {
      decoded = await gunzipAsync(bundle, { maxOutputLength: MAX_PACKAGE_BYTES })
    } catch {
      fail('INVALID_PROJECT_PACKAGE', 'Project package is not a valid AEONQUILL archive', 400)
    }
    let payload
    try {
      payload = JSON.parse(decoded.toString('utf8'))
    } catch {
      fail('INVALID_PROJECT_PACKAGE', 'Project package manifest is invalid', 400)
    }
    if (
      payload.packageSchemaVersion !== PACKAGE_SCHEMA_VERSION ||
      !isRecord(payload.project) ||
      !isRecord(payload.project.document) ||
      !Array.isArray(payload.assets)
    ) {
      fail('INVALID_PROJECT_PACKAGE', 'Project package structure is invalid', 400)
    }
    const staged = []
    let totalAssetBytes = 0
    for (const asset of payload.assets) {
      assertAssetId(asset.id)
      if (asset.sha256 !== asset.id || !MIME_EXTENSIONS.has(asset.mimeType) || typeof asset.dataBase64 !== 'string') {
        fail('INVALID_PROJECT_PACKAGE', `Asset metadata is invalid: ${asset.id}`, 400)
      }
      const bytes = Buffer.from(asset.dataBase64, 'base64')
      totalAssetBytes += bytes.length
      if (
        !bytes.length ||
        bytes.length > MAX_ASSET_BYTES ||
        totalAssetBytes > MAX_PACKAGE_BYTES ||
        bytes.length !== asset.bytes ||
        contentHash(bytes) !== asset.sha256
      ) {
        fail('ASSET_HASH_MISMATCH', `Asset package hash mismatch: ${asset.id}`, 409)
      }
      staged.push({ ...asset, bytes, extension: MIME_EXTENSIONS.get(asset.mimeType) })
    }
    return this.commitImportedProject(payload.project.document, staged, {
      ...options,
      assetVersions: payload.project.assetVersions,
    })
  }

  async importProject(sourceDirectory, options = {}) {
    this.assertOpen()
    const directory = resolve(sourceDirectory)
    const manifest = JSON.parse(await readFile(pathWithin(directory, join(directory, 'manifest.json')), 'utf8'))
    if (manifest.packageSchemaVersion !== PACKAGE_SCHEMA_VERSION || !isRecord(manifest.project) || !Array.isArray(manifest.assets)) {
      fail('INVALID_PROJECT_PACKAGE', 'Project package manifest is invalid', 400)
    }
    const document = JSON.parse(await readFile(pathWithin(directory, join(directory, manifest.project.documentPath)), 'utf8'))
    const staged = []
    for (const asset of manifest.assets) {
      assertAssetId(asset.id)
      if (asset.sha256 !== asset.id || !MIME_EXTENSIONS.has(asset.mimeType)) {
        fail('INVALID_PROJECT_PACKAGE', `Asset metadata is invalid: ${asset.id}`, 400)
      }
      const sourcePath = pathWithin(directory, join(directory, ...String(asset.path).split('/')))
      const bytes = await readFile(sourcePath)
      if (bytes.length !== asset.bytes || contentHash(bytes) !== asset.sha256) {
        fail('ASSET_HASH_MISMATCH', `Asset package hash mismatch: ${asset.id}`, 409)
      }
      staged.push({ ...asset, bytes, extension: MIME_EXTENSIONS.get(asset.mimeType) })
    }
    return this.commitImportedProject(document, staged, {
      ...options,
      assetVersions: manifest.assetVersions,
    })
  }

  async commitImportedProject(document, staged, options = {}) {
    const imported = cloneJson(document)
    if (options.projectId) imported.id = options.projectId
    assertProjectId(imported.id)
    try {
      assertCanvasDocument(imported)
    } catch (error) {
      fail(error.code || 'UNSUPPORTED_PROJECT_SCHEMA', error.message || 'Project package document schema is unsupported', 409)
    }
    const existingProject = this.getProject(imported.id)
    const now = Date.now()
    if (existingProject) {
      imported.revision = Math.max(imported.revision, existingProject.revision + 1)
      imported.updatedAt = Math.max(imported.createdAt, now)
    }
    const availableAssetIds = new Set([
      ...staged.map((asset) => asset.id),
      ...this.database.prepare('SELECT id FROM assets').all().map((asset) => asset.id),
    ])
    for (const assetId of collectAssetIds(imported)) {
      if (!availableAssetIds.has(assetId)) fail('ASSET_NOT_FOUND', `Package is missing asset: ${assetId}`, 409)
    }
    const importedVersions = []
    const importedVersionIds = new Set()
    const logicalVersions = new Set()
    if (Array.isArray(options.assetVersions)) {
      for (const version of options.assetVersions) {
        if (
          !isRecord(version) ||
          typeof version.id !== 'string' ||
          !ASSET_VERSION_ID_PATTERN.test(version.id) ||
          typeof version.logicalAssetId !== 'string' ||
          !version.logicalAssetId.trim() ||
          version.logicalAssetId.length > 240 ||
          !Number.isSafeInteger(version.version) ||
          version.version < 1 ||
          !availableAssetIds.has(version.assetId)
        ) {
          fail('INVALID_PROJECT_PACKAGE', 'Asset version metadata is invalid', 400)
        }
        const logicalKey = `${version.logicalAssetId}\0${version.version}`
        if (importedVersionIds.has(version.id) || logicalVersions.has(logicalKey)) {
          fail('INVALID_PROJECT_PACKAGE', 'Asset version metadata contains duplicates', 400)
        }
        importedVersionIds.add(version.id)
        logicalVersions.add(logicalKey)
        importedVersions.push({
          id: version.id,
          logicalAssetId: version.logicalAssetId,
          version: version.version,
          assetId: version.assetId,
          parentVersionId: typeof version.parentVersionId === 'string' ? version.parentVersionId : undefined,
          sourceElementId: typeof version.sourceElementId === 'string' ? version.sourceElementId : undefined,
          provenance: isRecord(version.provenance) ? version.provenance : { source: 'package-import' },
        })
      }
      for (const version of importedVersions) {
        if (version.parentVersionId && !importedVersionIds.has(version.parentVersionId)) {
          fail('INVALID_PROJECT_PACKAGE', `Asset version parent is missing: ${version.parentVersionId}`, 409)
        }
      }
    } else {
      for (const element of imported.elements) {
        const renderedReference = element.kind === 'video' ? element.videoSrc : element.src
        const match = /^\/api\/project-assets\/([a-f0-9]{64})$/.exec(renderedReference || '')
        if (!match || !element.assetVersionId || !element.assetId || !Number.isSafeInteger(element.assetVersion)) continue
        importedVersions.push({
          id: element.assetVersionId,
          logicalAssetId: element.assetId,
          version: element.assetVersion,
          assetId: match[1],
          sourceElementId: element.sourceElementId,
          provenance: { source: 'package-import' },
        })
        importedVersionIds.add(element.assetVersionId)
      }
    }
    for (const element of imported.elements) {
      if (element.assetVersionId && !importedVersionIds.has(element.assetVersionId)) {
        fail('INVALID_PROJECT_PACKAGE', `Document asset version is missing: ${element.assetVersionId}`, 409)
      }
    }

    const createdFiles = []
    try {
      this.database.exec('BEGIN IMMEDIATE')
      const insertAsset = this.database.prepare(`
        INSERT OR IGNORE INTO assets
          (id, sha256, mime_type, extension, bytes, relative_path, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const asset of staged) {
        const relativePath = assetFilename(asset.id, asset.extension)
        const finalPath = pathWithin(this.assetDirectory, join(this.assetDirectory, relativePath))
        try {
          await writeFile(finalPath, asset.bytes, { flag: 'wx' })
          createdFiles.push(finalPath)
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
        insertAsset.run(
          asset.id, asset.sha256, asset.mimeType, asset.extension, asset.bytes,
          relativePath, stableJson(asset.provenance || { source: 'package-import' }), now,
        )
      }
      const serialized = stableJson(imported)
      this.database.prepare(`
        INSERT INTO projects (id, title, schema_version, revision, document_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, schema_version = excluded.schema_version,
          revision = excluded.revision, document_json = excluded.document_json, updated_at = excluded.updated_at
      `).run(imported.id, imported.title, imported.schemaVersion, imported.revision, serialized, now, now)
      this.database.prepare('DELETE FROM asset_versions WHERE project_id = ?').run(imported.id)
      const insertVersion = this.database.prepare(`
        INSERT INTO asset_versions
          (project_id, id, logical_asset_id, version, asset_id, parent_version_id,
           source_element_id, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const version of importedVersions) {
        insertVersion.run(
          imported.id,
          version.id,
          version.logicalAssetId,
          version.version,
          version.assetId,
          version.parentVersionId || null,
          version.sourceElementId || null,
          stableJson(version.provenance),
          now,
        )
      }
      this.database.prepare('DELETE FROM project_assets WHERE project_id = ?').run(imported.id)
      const link = this.database.prepare(`INSERT INTO project_assets (project_id, asset_id, role) VALUES (?, ?, 'document')`)
      const linkedAssetIds = new Set([
        ...collectAssetIds(imported),
        ...importedVersions.map((version) => version.assetId),
      ])
      for (const assetId of linkedAssetIds) link.run(imported.id, assetId)
      this.database.exec('COMMIT')
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch {}
      for (const filePath of createdFiles) await unlink(filePath).catch(() => {})
      throw error
    }
    return this.getProject(imported.id)
  }

  async createExportDirectory(projectId) {
    const directory = await mkdtemp(join(this.tempDirectory, `export-${projectId}-`))
    await this.exportProject(projectId, directory)
    return directory
  }

  async destroyExportDirectory(directory) {
    const safe = pathWithin(this.tempDirectory, directory)
    await rm(safe, { recursive: true, force: true })
  }
}

export {
  MAX_ASSET_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PROJECT_BYTES,
  PACKAGE_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
}
