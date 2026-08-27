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
const LIBRARY_ID_PATTERN = /^(?:library|collection)-[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/
const LIBRARY_SCOPES = new Set(['global', 'project'])
const MAX_LIBRARY_TAGS = 12
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

function assertLibraryId(value, label = 'Library id') {
  if (typeof value !== 'string' || !LIBRARY_ID_PATTERN.test(value)) {
    fail('INVALID_LIBRARY_ID', `${label} is invalid`, 400)
  }
  return value
}

function normalizeLibraryScope(scope, projectId) {
  if (!LIBRARY_SCOPES.has(scope)) fail('INVALID_LIBRARY_SCOPE', 'Library scope must be global or project', 400)
  if (scope === 'project') {
    assertProjectId(projectId)
    return { scope, projectId }
  }
  if (projectId !== undefined && projectId !== null) {
    fail('INVALID_LIBRARY_SCOPE', 'Global library items cannot carry a project id', 400)
  }
  return { scope, projectId: null }
}

function normalizeLibraryText(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('INVALID_LIBRARY_METADATA', `${label} is required`, 400)
    return ''
  }
  if (typeof value !== 'string') fail('INVALID_LIBRARY_METADATA', `${label} must be text`, 400)
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if ((required && !normalized) || normalized.length > maximum) {
    fail('INVALID_LIBRARY_METADATA', `${label} must contain ${required ? '1' : '0'}-${maximum} characters`, 400)
  }
  return normalized
}

function normalizeLibraryTags(tags = []) {
  if (!Array.isArray(tags) || tags.length > MAX_LIBRARY_TAGS) {
    fail('INVALID_LIBRARY_TAGS', `Library tags must contain at most ${MAX_LIBRARY_TAGS} entries`, 400)
  }
  const normalized = tags.map((tag) => normalizeLibraryText(tag, 'Library tag', 40, { required: true }).toLocaleLowerCase('zh-CN'))
  if (new Set(normalized).size !== normalized.length) fail('INVALID_LIBRARY_TAGS', 'Library tags must be unique', 400)
  return normalized.sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

function libraryMediaKind(mimeType) {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  fail('UNSUPPORTED_ASSET_TYPE', `Unsupported library asset type: ${mimeType}`, 415)
}

function libraryVersionId(itemId, version, assetId) {
  const digest = contentHash(Buffer.from(`${itemId}\0${version}\0${assetId}`, 'utf8'))
  return `library-version-${digest.slice(0, 32)}`
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
      CREATE TABLE IF NOT EXISTS library_items (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
        project_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        media_kind TEXT NOT NULL CHECK(media_kind IN ('image', 'video', 'audio')),
        source_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS library_versions (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version > 0),
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
        parent_version_id TEXT,
        provenance_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(item_id, version)
      );
      CREATE TABLE IF NOT EXISTS library_tags (
        item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY(item_id, tag)
      );
      CREATE TABLE IF NOT EXISTS library_collections (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
        project_id TEXT,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS library_collection_items (
        collection_id TEXT NOT NULL REFERENCES library_collections(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        PRIMARY KEY(collection_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS library_project_refs (
        project_id TEXT NOT NULL,
        item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL REFERENCES library_versions(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS library_items_scope_project ON library_items(scope, project_id, updated_at);
      CREATE INDEX IF NOT EXISTS library_versions_asset_id ON library_versions(asset_id);
      CREATE INDEX IF NOT EXISTS library_versions_item ON library_versions(item_id, version);
      CREATE INDEX IF NOT EXISTS library_project_refs_project ON library_project_refs(project_id, created_at);
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

  libraryTags(itemId) {
    return this.database.prepare('SELECT tag FROM library_tags WHERE item_id = ? ORDER BY tag ASC')
      .all(itemId).map(({ tag }) => tag)
  }

  libraryCollections(itemId) {
    return this.database.prepare(`
      SELECT c.id, c.scope, c.project_id AS projectId, c.title
      FROM library_collections c
      JOIN library_collection_items ci ON ci.collection_id = c.id
      WHERE ci.item_id = ?
      ORDER BY c.title ASC, c.id ASC
    `).all(itemId)
  }

  libraryVersion(versionId) {
    return this.database.prepare(`
      SELECT v.id, v.item_id AS itemId, v.version, v.asset_id AS assetId,
             v.parent_version_id AS parentVersionId, v.provenance_json AS provenanceJson,
             v.created_at AS createdAt, a.mime_type AS mimeType, a.extension, a.bytes
      FROM library_versions v
      JOIN assets a ON a.id = v.asset_id
      WHERE v.id = ?
    `).get(versionId)
  }

  hydrateLibraryItem(row, projectId = undefined) {
    if (!row) return null
    const latest = this.database.prepare(`
      SELECT id FROM library_versions WHERE item_id = ? ORDER BY version DESC LIMIT 1
    `).get(row.id)
    const reference = projectId && row.scope === 'global'
      ? this.database.prepare(`
          SELECT version_id AS versionId FROM library_project_refs WHERE project_id = ? AND item_id = ?
        `).get(projectId, row.id)
      : null
    const selectedVersion = this.libraryVersion(reference?.versionId || latest?.id)
    if (!selectedVersion) fail('LIBRARY_VERSION_NOT_FOUND', `Library item has no usable version: ${row.id}`, 500)
    const latestVersion = this.libraryVersion(latest.id)
    return {
      id: row.id,
      scope: row.scope,
      projectId: row.projectId || undefined,
      title: row.title,
      description: row.description,
      mediaKind: row.mediaKind,
      sourceItemId: row.sourceItemId || undefined,
      relationship: row.scope === 'project' ? 'project-owned' : reference ? 'global-reference' : 'global',
      tags: this.libraryTags(row.id),
      collections: this.libraryCollections(row.id),
      versionCount: Number(latestVersion.version),
      latestVersionId: latestVersion.id,
      version: {
        id: selectedVersion.id,
        version: Number(selectedVersion.version),
        assetId: selectedVersion.assetId,
        parentVersionId: selectedVersion.parentVersionId || undefined,
        provenance: JSON.parse(selectedVersion.provenanceJson),
        createdAt: Number(selectedVersion.createdAt),
        mimeType: selectedVersion.mimeType,
        extension: selectedVersion.extension,
        bytes: Number(selectedVersion.bytes),
        url: `/api/project-assets/${selectedVersion.assetId}`,
      },
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    }
  }

  getLibraryAsset(itemId, options = {}) {
    this.assertOpen()
    assertLibraryId(itemId, 'Library item id')
    const row = this.database.prepare(`
      SELECT id, scope, project_id AS projectId, title, description, media_kind AS mediaKind,
             source_item_id AS sourceItemId, created_at AS createdAt, updated_at AS updatedAt
      FROM library_items WHERE id = ?
    `).get(itemId)
    if (!row) return null
    if (row.scope === 'project' && options.projectId !== row.projectId) {
      fail('LIBRARY_ITEM_FORBIDDEN', 'Project library item belongs to another project', 403)
    }
    if (options.projectId !== undefined) assertProjectId(options.projectId)
    return this.hydrateLibraryItem(row, options.projectId)
  }

  listLibraryAssets(options = {}) {
    this.assertOpen()
    const { scope, projectId } = normalizeLibraryScope(options.scope || 'global', options.projectId)
    const query = normalizeLibraryText(options.query, 'Library query', 120).toLocaleLowerCase('zh-CN')
    const requestedTags = normalizeLibraryTags(options.tags || [])
    const collectionId = options.collectionId === undefined ? undefined : assertLibraryId(options.collectionId, 'Collection id')
    const rows = scope === 'global'
      ? this.database.prepare(`
          SELECT id, scope, project_id AS projectId, title, description, media_kind AS mediaKind,
                 source_item_id AS sourceItemId, created_at AS createdAt, updated_at AS updatedAt
          FROM library_items WHERE scope = 'global'
          ORDER BY updated_at DESC, id ASC LIMIT 500
        `).all()
      : this.database.prepare(`
          SELECT DISTINCT i.id, i.scope, i.project_id AS projectId, i.title, i.description,
                 i.media_kind AS mediaKind, i.source_item_id AS sourceItemId,
                 i.created_at AS createdAt, i.updated_at AS updatedAt
          FROM library_items i
          LEFT JOIN library_project_refs r ON r.item_id = i.id AND r.project_id = ?
          WHERE (i.scope = 'project' AND i.project_id = ?) OR r.project_id = ?
          ORDER BY i.updated_at DESC, i.id ASC LIMIT 500
        `).all(projectId, projectId, projectId)
    return rows.map((row) => this.hydrateLibraryItem(row, projectId || undefined)).filter((item) => {
      if (query) {
        const haystack = `${item.title}\n${item.description}\n${item.tags.join('\n')}`.toLocaleLowerCase('zh-CN')
        if (!haystack.includes(query)) return false
      }
      if (requestedTags.some((tag) => !item.tags.includes(tag))) return false
      if (collectionId && !item.collections.some(({ id }) => id === collectionId)) return false
      return true
    })
  }

  async stageLibraryContent(dataUrl, provenance, now) {
    const decoded = decodeSupportedDataUrl(dataUrl)
    const assetId = contentHash(decoded.bytes)
    const existing = this.getAsset(assetId)
    if (existing) {
      if (existing.mimeType !== decoded.mimeType || existing.bytes !== decoded.bytes.length) {
        fail('ASSET_HASH_MISMATCH', 'Existing content asset metadata does not match imported bytes', 409)
      }
      return { asset: existing, createdFile: false, insertRequired: false }
    }
    const relativePath = assetFilename(assetId, decoded.extension)
    const finalPath = pathWithin(this.assetDirectory, join(this.assetDirectory, relativePath))
    const temporaryPath = pathWithin(this.tempDirectory, join(this.tempDirectory, `${assetId}-${randomUUID()}.tmp`))
    await writeFile(temporaryPath, decoded.bytes, { flag: 'wx' })
    let createdFile = false
    try {
      await rename(temporaryPath, finalPath)
      createdFile = true
    } catch (error) {
      await unlink(temporaryPath).catch(() => {})
      if (error.code !== 'EEXIST') throw error
    }
    return {
      asset: {
        id: assetId,
        sha256: assetId,
        mimeType: decoded.mimeType,
        extension: decoded.extension,
        bytes: decoded.bytes.length,
        relativePath,
        provenance,
        createdAt: now,
      },
      createdFile,
      insertRequired: true,
    }
  }

  insertStagedLibraryAsset(staged, now) {
    if (!staged.insertRequired) return
    this.database.prepare(`
      INSERT OR IGNORE INTO assets
        (id, sha256, mime_type, extension, bytes, relative_path, provenance_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      staged.asset.id,
      staged.asset.sha256,
      staged.asset.mimeType,
      staged.asset.extension,
      staged.asset.bytes,
      staged.asset.relativePath,
      stableJson(staged.asset.provenance),
      now,
    )
  }

  validateLibraryCollections(collectionIds, scope, projectId) {
    if (collectionIds === undefined) return []
    if (!Array.isArray(collectionIds) || collectionIds.length > 20) {
      fail('INVALID_LIBRARY_COLLECTIONS', 'Library collections must contain at most 20 ids', 400)
    }
    const ids = collectionIds.map((id) => assertLibraryId(id, 'Collection id'))
    if (new Set(ids).size !== ids.length) fail('INVALID_LIBRARY_COLLECTIONS', 'Library collection ids must be unique', 400)
    for (const id of ids) {
      const collection = this.database.prepare(`
        SELECT id, scope, project_id AS projectId FROM library_collections WHERE id = ?
      `).get(id)
      if (!collection) fail('LIBRARY_COLLECTION_NOT_FOUND', `Library collection was not found: ${id}`, 404)
      if (collection.scope !== scope || (scope === 'project' && collection.projectId !== projectId)) {
        fail('LIBRARY_COLLECTION_SCOPE_MISMATCH', 'Library item and collection scopes do not match', 409)
      }
    }
    return ids
  }

  replaceLibraryTags(itemId, tags) {
    this.database.prepare('DELETE FROM library_tags WHERE item_id = ?').run(itemId)
    const insert = this.database.prepare('INSERT INTO library_tags (item_id, tag) VALUES (?, ?)')
    for (const tag of tags) insert.run(itemId, tag)
  }

  replaceLibraryCollections(itemId, collectionIds) {
    this.database.prepare('DELETE FROM library_collection_items WHERE item_id = ?').run(itemId)
    const insert = this.database.prepare(`
      INSERT INTO library_collection_items (collection_id, item_id) VALUES (?, ?)
    `)
    for (const collectionId of collectionIds) insert.run(collectionId, itemId)
  }

  async createLibraryAsset(input, options = {}) {
    this.assertOpen()
    const now = options.now ?? Date.now()
    const { scope, projectId } = normalizeLibraryScope(input.scope, input.projectId)
    const title = normalizeLibraryText(input.title, 'Library title', 120, { required: true })
    const description = normalizeLibraryText(input.description, 'Library description', 600)
    const tags = normalizeLibraryTags(input.tags)
    const collectionIds = this.validateLibraryCollections(input.collectionIds, scope, projectId)
    const itemId = input.id === undefined ? `library-${randomUUID()}` : assertLibraryId(input.id, 'Library item id')
    if (this.database.prepare('SELECT 1 FROM library_items WHERE id = ?').get(itemId)) {
      fail('LIBRARY_ITEM_CONFLICT', `Library item already exists: ${itemId}`, 409)
    }
    const extraProvenance = isRecord(options.provenance) ? cloneJson(options.provenance) : {}
    const provenance = {
      ...extraProvenance,
      source: options.source || 'user-library-import',
      importedAt: now,
    }
    const staged = await this.stageLibraryContent(input.dataUrl, provenance, now)
    const mediaKind = libraryMediaKind(staged.asset.mimeType)
    const versionId = libraryVersionId(itemId, 1, staged.asset.id)
    try {
      this.database.exec('BEGIN IMMEDIATE')
      this.insertStagedLibraryAsset(staged, now)
      this.database.prepare(`
        INSERT INTO library_items
          (id, scope, project_id, title, description, media_kind, source_item_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(itemId, scope, projectId, title, description, mediaKind, now, now)
      this.database.prepare(`
        INSERT INTO library_versions
          (id, item_id, version, asset_id, parent_version_id, provenance_json, created_at)
        VALUES (?, ?, 1, ?, NULL, ?, ?)
      `).run(versionId, itemId, staged.asset.id, stableJson(provenance), now)
      this.replaceLibraryTags(itemId, tags)
      this.replaceLibraryCollections(itemId, collectionIds)
      this.database.exec('COMMIT')
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch {}
      if (staged.createdFile) await unlink(this.assetPath(staged.asset)).catch(() => {})
      throw error
    }
    return this.getLibraryAsset(itemId, projectId ? { projectId } : {})
  }

  linkLibraryAssetToProject(itemId, projectId, versionId = undefined, options = {}) {
    this.assertOpen()
    assertLibraryId(itemId, 'Library item id')
    assertProjectId(projectId)
    const item = this.database.prepare('SELECT id, scope FROM library_items WHERE id = ?').get(itemId)
    if (!item) fail('LIBRARY_ITEM_NOT_FOUND', `Library item was not found: ${itemId}`, 404)
    if (item.scope !== 'global') fail('LIBRARY_LINK_SCOPE_MISMATCH', 'Only global assets can be linked into a project', 409)
    const selected = versionId
      ? this.libraryVersion(versionId)
      : this.database.prepare(`
          SELECT id FROM library_versions WHERE item_id = ? ORDER BY version DESC LIMIT 1
        `).get(itemId)
    const selectedVersion = selected?.itemId ? selected : this.libraryVersion(selected?.id)
    if (!selectedVersion || selectedVersion.itemId !== itemId) {
      fail('LIBRARY_VERSION_NOT_FOUND', 'Selected library version does not belong to this item', 404)
    }
    const now = options.now ?? Date.now()
    this.database.prepare(`
      INSERT INTO library_project_refs (project_id, item_id, version_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, item_id) DO UPDATE SET version_id = excluded.version_id
    `).run(projectId, itemId, selectedVersion.id, now)
    return this.getLibraryAsset(itemId, { projectId })
  }

  async deriveLibraryAsset(itemId, input, options = {}) {
    this.assertOpen()
    assertLibraryId(itemId, 'Library item id')
    assertProjectId(input.projectId)
    const sourceItem = this.getLibraryAsset(itemId, itemId.startsWith('library-') ? { projectId: input.projectId } : {})
    if (!sourceItem) fail('LIBRARY_ITEM_NOT_FOUND', `Library item was not found: ${itemId}`, 404)
    if (sourceItem.scope === 'project' && sourceItem.projectId !== input.projectId) {
      fail('LIBRARY_ITEM_FORBIDDEN', 'Cannot derive another project library item', 403)
    }
    const sourceVersion = input.sourceVersionId
      ? this.libraryVersion(input.sourceVersionId)
      : this.libraryVersion(sourceItem.version.id)
    if (!sourceVersion || sourceVersion.itemId !== itemId) {
      fail('LIBRARY_VERSION_NOT_FOUND', 'Source version does not belong to the selected library item', 404)
    }
    const now = options.now ?? Date.now()
    const title = normalizeLibraryText(input.title || `${sourceItem.title} · 派生`, 'Library title', 120, { required: true })
    const description = normalizeLibraryText(input.description ?? sourceItem.description, 'Library description', 600)
    const tags = normalizeLibraryTags(input.tags ?? sourceItem.tags)
    const collectionIds = this.validateLibraryCollections(input.collectionIds, 'project', input.projectId)
    const derivedItemId = input.id === undefined ? `library-${randomUUID()}` : assertLibraryId(input.id, 'Library item id')
    if (this.database.prepare('SELECT 1 FROM library_items WHERE id = ?').get(derivedItemId)) {
      fail('LIBRARY_ITEM_CONFLICT', `Library item already exists: ${derivedItemId}`, 409)
    }
    const provenance = {
      source: options.source || 'project-derived-library-asset',
      sourceItemId: itemId,
      sourceVersionId: sourceVersion.id,
      derivedAt: now,
    }
    const staged = input.dataUrl
      ? await this.stageLibraryContent(input.dataUrl, provenance, now)
      : { asset: this.getAsset(sourceVersion.assetId), createdFile: false, insertRequired: false }
    if (!staged.asset) fail('ASSET_NOT_FOUND', 'Source library content asset is missing', 409)
    const mediaKind = libraryMediaKind(staged.asset.mimeType)
    if (mediaKind !== sourceItem.mediaKind) fail('LIBRARY_MEDIA_KIND_MISMATCH', 'Derived asset media kind cannot change', 409)
    const versionId = libraryVersionId(derivedItemId, 1, staged.asset.id)
    try {
      this.database.exec('BEGIN IMMEDIATE')
      this.insertStagedLibraryAsset(staged, now)
      this.database.prepare(`
        INSERT INTO library_items
          (id, scope, project_id, title, description, media_kind, source_item_id, created_at, updated_at)
        VALUES (?, 'project', ?, ?, ?, ?, ?, ?, ?)
      `).run(derivedItemId, input.projectId, title, description, mediaKind, itemId, now, now)
      this.database.prepare(`
        INSERT INTO library_versions
          (id, item_id, version, asset_id, parent_version_id, provenance_json, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?)
      `).run(versionId, derivedItemId, staged.asset.id, sourceVersion.id, stableJson(provenance), now)
      this.replaceLibraryTags(derivedItemId, tags)
      this.replaceLibraryCollections(derivedItemId, collectionIds)
      this.database.exec('COMMIT')
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch {}
      if (staged.createdFile) await unlink(this.assetPath(staged.asset)).catch(() => {})
      throw error
    }
    return this.getLibraryAsset(derivedItemId, { projectId: input.projectId })
  }

  async addLibraryAssetVersion(itemId, input, options = {}) {
    this.assertOpen()
    assertLibraryId(itemId, 'Library item id')
    assertProjectId(input.projectId)
    const item = this.database.prepare(`
      SELECT id, scope, project_id AS projectId, media_kind AS mediaKind FROM library_items WHERE id = ?
    `).get(itemId)
    if (!item) fail('LIBRARY_ITEM_NOT_FOUND', `Library item was not found: ${itemId}`, 404)
    if (item.scope !== 'project' || item.projectId !== input.projectId) {
      fail('LIBRARY_ORIGINAL_IMMUTABLE', 'Global or foreign project assets cannot be edited in place; create a project derivative', 409)
    }
    const previous = this.database.prepare(`
      SELECT id, version FROM library_versions WHERE item_id = ? ORDER BY version DESC LIMIT 1
    `).get(itemId)
    if (!previous) fail('LIBRARY_VERSION_NOT_FOUND', 'Library item has no current version', 500)
    const now = options.now ?? Date.now()
    const provenance = {
      source: options.source || 'project-library-edit',
      parentVersionId: previous.id,
      createdAt: now,
    }
    const staged = await this.stageLibraryContent(input.dataUrl, provenance, now)
    if (libraryMediaKind(staged.asset.mimeType) !== item.mediaKind) {
      if (staged.createdFile) await unlink(this.assetPath(staged.asset)).catch(() => {})
      fail('LIBRARY_MEDIA_KIND_MISMATCH', 'A library version cannot change media kind', 409)
    }
    const version = Number(previous.version) + 1
    const versionId = libraryVersionId(itemId, version, staged.asset.id)
    try {
      this.database.exec('BEGIN IMMEDIATE')
      this.insertStagedLibraryAsset(staged, now)
      this.database.prepare(`
        INSERT INTO library_versions
          (id, item_id, version, asset_id, parent_version_id, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(versionId, itemId, version, staged.asset.id, previous.id, stableJson(provenance), now)
      this.database.prepare('UPDATE library_items SET updated_at = ? WHERE id = ?').run(now, itemId)
      this.database.exec('COMMIT')
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch {}
      if (staged.createdFile) await unlink(this.assetPath(staged.asset)).catch(() => {})
      throw error
    }
    return this.getLibraryAsset(itemId, { projectId: input.projectId })
  }

  updateLibraryAssetMetadata(itemId, input, options = {}) {
    this.assertOpen()
    assertLibraryId(itemId, 'Library item id')
    const item = this.database.prepare(`
      SELECT id, scope, project_id AS projectId, title, description FROM library_items WHERE id = ?
    `).get(itemId)
    if (!item) fail('LIBRARY_ITEM_NOT_FOUND', `Library item was not found: ${itemId}`, 404)
    if (item.scope === 'project' && input.projectId !== item.projectId) {
      fail('LIBRARY_ITEM_FORBIDDEN', 'Project library item belongs to another project', 403)
    }
    if (input.projectId !== undefined) assertProjectId(input.projectId)
    const title = input.title === undefined ? item.title : normalizeLibraryText(input.title, 'Library title', 120, { required: true })
    const description = input.description === undefined
      ? item.description
      : normalizeLibraryText(input.description, 'Library description', 600)
    const tags = input.tags === undefined ? this.libraryTags(itemId) : normalizeLibraryTags(input.tags)
    const collectionIds = input.collectionIds === undefined
      ? this.libraryCollections(itemId).map(({ id }) => id)
      : this.validateLibraryCollections(input.collectionIds, item.scope, item.projectId)
    const now = options.now ?? Date.now()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        UPDATE library_items SET title = ?, description = ?, updated_at = ? WHERE id = ?
      `).run(title, description, now, itemId)
      this.replaceLibraryTags(itemId, tags)
      this.replaceLibraryCollections(itemId, collectionIds)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return this.getLibraryAsset(itemId, item.scope === 'project' ? { projectId: item.projectId } : {})
  }

  createLibraryCollection(input, options = {}) {
    this.assertOpen()
    const { scope, projectId } = normalizeLibraryScope(input.scope, input.projectId)
    const title = normalizeLibraryText(input.title, 'Collection title', 80, { required: true })
    const id = input.id === undefined ? `collection-${randomUUID()}` : assertLibraryId(input.id, 'Collection id')
    const now = options.now ?? Date.now()
    try {
      this.database.prepare(`
        INSERT INTO library_collections (id, scope, project_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, scope, projectId, title, now, now)
    } catch (error) {
      if (error.code === 'ERR_SQLITE_CONSTRAINT_PRIMARYKEY') {
        fail('LIBRARY_COLLECTION_CONFLICT', `Library collection already exists: ${id}`, 409)
      }
      throw error
    }
    return { id, scope, projectId: projectId || undefined, title, createdAt: now, updatedAt: now }
  }

  listLibraryCollections(options = {}) {
    this.assertOpen()
    const { scope, projectId } = normalizeLibraryScope(options.scope || 'global', options.projectId)
    return this.database.prepare(`
      SELECT c.id, c.scope, c.project_id AS projectId, c.title,
             c.created_at AS createdAt, c.updated_at AS updatedAt, COUNT(ci.item_id) AS itemCount
      FROM library_collections c
      LEFT JOIN library_collection_items ci ON ci.collection_id = c.id
      WHERE c.scope = ? AND c.project_id IS ?
      GROUP BY c.id
      ORDER BY c.title ASC, c.id ASC
    `).all(scope, projectId).map((row) => ({ ...row, projectId: row.projectId || undefined, itemCount: Number(row.itemCount) }))
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
        AND NOT EXISTS (SELECT 1 FROM library_versions lv WHERE lv.asset_id = a.id)
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
             OR EXISTS (SELECT 1 FROM library_versions WHERE asset_id = ?)
        `).get(asset.id, asset.id, asset.id)
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
