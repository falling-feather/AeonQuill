import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, statfs, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'

import { assertCanvasDocument } from '../src/lib/canvasCore.mjs'
import { assertProjectCatalog, PROJECT_CATALOG_SCHEMA_VERSION } from '../src/lib/project/projectCatalog.mjs'
import { MAX_ASSET_BYTES, MAX_PACKAGE_BYTES, contentHash } from './project-store.mjs'
import { validateWorkspaceModeDocument } from './workspace-store.mjs'

export const AEONQUILL_PACKAGE_MAGIC = 'AEONQUILL_PROJECT_PACKAGE'
export const AEONQUILL_PACKAGE_SCHEMA_VERSION = 1
export const AEONQUILL_PACKAGE_MIME = 'application/vnd.aeonquill.project'
export const AEONQUILL_PACKAGE_EXTENSION = '.aeonquill'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const ASSET_ID_PATTERN = /^[a-f0-9]{64}$/u
const ASSET_VERSION_ID_PATTERN = /^asset-version-[a-f0-9]{32}$/u
const LIBRARY_ID_PATTERN = /^(?:library|collection)-[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u
const LIBRARY_VERSION_ID_PATTERN = /^library-version-[a-f0-9]{32}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MIME_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['video/mp4', 'mp4'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
])
const PACKAGE_HEADROOM_BYTES = 16 * 1024 * 1024

export class ProjectPackageError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.name = 'ProjectPackageError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function fail(code, message, status = 400, details = undefined) {
  throw new ProjectPackageError(code, message, status, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) fail('INVALID_AEONQUILL_PACKAGE', `${label} must be an object`)
  const allowed = new Set(keys)
  const actual = Object.keys(value)
  const unknown = actual.filter((key) => !allowed.has(key))
  const missing = keys.filter((key) => !(key in value))
  if (unknown.length || missing.length) {
    fail('INVALID_AEONQUILL_PACKAGE', `${label} fields do not match the supported schema`, 400, { unknown, missing })
  }
  return value
}

function assertId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('INVALID_AEONQUILL_PACKAGE', `${label} is invalid`)
  }
  return value
}

function assertLibraryId(value, label) {
  if (typeof value !== 'string' || !LIBRARY_ID_PATTERN.test(value)) {
    fail('INVALID_AEONQUILL_PACKAGE', `${label} is invalid`)
  }
  return value
}

function assertInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail('INVALID_AEONQUILL_PACKAGE', `${label} must be an integer >= ${minimum}`)
  }
  return value
}

function assertText(value, label, maximum, { nullable = false } = {}) {
  if (nullable && value === null) return value
  if (typeof value !== 'string' || value.length > maximum) {
    fail('INVALID_AEONQUILL_PACKAGE', `${label} must be text no longer than ${maximum} characters`)
  }
  return value
}

function jsonHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function canonicalAssetPath(assetId, extension) {
  return `assets/${assetId}.${extension}`
}

function validateBase64(value, label) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/u.test(value)) {
    fail('INVALID_AEONQUILL_PACKAGE', `${label} is not canonical base64`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) fail('INVALID_AEONQUILL_PACKAGE', `${label} is not canonical base64`)
  return bytes
}

function collectAssetReferences(value, target, key = '', seen = new Set()) {
  if (typeof value === 'string') {
    const route = /^\/api\/project-assets\/([a-f0-9]{64})$/u.exec(value)
    if (route) target.add(route[1])
    else if (/assetid$/iu.test(key) && ASSET_ID_PATTERN.test(value)) target.add(value)
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectAssetReferences(item, target, key, seen)
    return
  }
  for (const [childKey, child] of Object.entries(value)) collectAssetReferences(child, target, childKey, seen)
}

function libraryVersionId(itemId, version, assetId) {
  const digest = contentHash(Buffer.from(`${itemId}\0${version}\0${assetId}`, 'utf8'))
  return `library-version-${digest.slice(0, 32)}`
}

function uniqueId(prefix, occupied) {
  let candidate
  do {
    candidate = `${prefix}-${randomUUID()}`.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 160)
  } while (occupied.has(candidate))
  occupied.add(candidate)
  return candidate
}

function safeTitle(title, suffix) {
  const base = typeof title === 'string' && title.trim() ? title.trim() : '导入项目'
  return `${base}${suffix}`.slice(0, 120)
}

function rowJson(value, label) {
  try {
    return JSON.parse(value)
  } catch {
    fail('PROJECT_PACKAGE_SOURCE_CORRUPT', `${label} contains invalid JSON`, 500)
  }
}

function packagePreview(payload, sizes = {}) {
  const documentCounts = { balanced: 0, pixel: 0, 'smart-video': 0 }
  const bodyCounts = { balanced: 0, pixel: 0, 'smart-video': 0 }
  const missingBodies = []
  for (const document of payload.documents) {
    documentCounts[document.modeId] += 1
    if (document.value === null) missingBodies.push(document.documentId)
    else bodyCounts[document.modeId] += 1
  }
  const balancedIds = new Set(payload.balancedProjects.map(({ documentId }) => documentId))
  const missingBalancedMetadata = payload.documents
    .filter(({ modeId, value }) => modeId === 'balanced' && value !== null)
    .map(({ documentId }) => documentId)
    .filter((documentId) => !balancedIds.has(documentId))
  const assetBytes = payload.assets.reduce((sum, asset) => sum + asset.bytes, 0)
  return {
    format: 'aeonquill-project',
    packageSchemaVersion: AEONQUILL_PACKAGE_SCHEMA_VERSION,
    complete: missingBodies.length === 0 && missingBalancedMetadata.length === 0,
    project: {
      id: payload.project.id,
      title: payload.project.title,
      initialModeId: payload.project.initialModeId,
      status: payload.project.status,
    },
    documents: {
      total: payload.documents.length,
      byMode: documentCounts,
      bodiesByMode: bodyCounts,
      missingBodies,
      missingBalancedMetadata,
    },
    recoveryPoints: payload.recoveryPoints.length,
    library: {
      collections: payload.library.collections.length,
      projectItems: payload.library.items.filter(({ scope }) => scope === 'project').length,
      globalReferences: payload.library.references.length,
      versions: payload.library.versions.length,
    },
    assets: { count: payload.assets.length, bytes: assetBytes },
    rawBytes: sizes.rawBytes ?? null,
    archiveBytes: sizes.archiveBytes ?? null,
    warnings: [
      ...(missingBodies.length ? [`${missingBodies.length} 个刚创建但尚无正文的文档只会保留目录登记`] : []),
      ...(missingBalancedMetadata.length ? [`${missingBalancedMetadata.length} 个均衡正文缺少资产版本元数据`] : []),
    ],
  }
}

function legacyPreview(payload, archiveBytes) {
  return {
    format: 'legacy-miaohui-canvas',
    packageSchemaVersion: payload?.packageSchemaVersion ?? null,
    complete: false,
    project: {
      id: payload?.project?.id ?? payload?.project?.document?.id ?? 'legacy-canvas',
      title: payload?.project?.title ?? payload?.project?.document?.title ?? '旧版均衡画布',
      initialModeId: 'balanced',
      status: 'active',
    },
    documents: {
      total: 1,
      byMode: { balanced: 1, pixel: 0, 'smart-video': 0 },
      bodiesByMode: { balanced: 1, pixel: 0, 'smart-video': 0 },
      missingBodies: [],
      missingBalancedMetadata: [],
    },
    recoveryPoints: 0,
    library: { collections: 0, projectItems: 0, globalReferences: 0, versions: 0 },
    assets: {
      count: Array.isArray(payload?.assets) ? payload.assets.length : 0,
      bytes: Array.isArray(payload?.assets) ? payload.assets.reduce((sum, asset) => sum + (Number(asset?.bytes) || 0), 0) : 0,
    },
    rawBytes: null,
    archiveBytes,
    warnings: ['这是旧 `.miaohui` 单画布兼容包；不包含像素/智能视频正文、恢复点或项目资源关系。'],
  }
}

function validateDocumentEntry(entry, registration, index) {
  exactKeys(entry, ['documentId', 'modeId', 'revision', 'value', 'valueSha256', 'createdAt', 'updatedAt'], `payload.documents[${index}]`)
  if (entry.documentId !== registration.id || entry.modeId !== registration.modeId || entry.revision !== registration.revision) {
    fail('INVALID_AEONQUILL_PACKAGE', `payload.documents[${index}] does not match its project registration`)
  }
  assertInteger(entry.createdAt, `payload.documents[${index}].createdAt`)
  assertInteger(entry.updatedAt, `payload.documents[${index}].updatedAt`)
  if (entry.value === null) {
    if (entry.valueSha256 !== null) fail('INVALID_AEONQUILL_PACKAGE', `payload.documents[${index}] has a hash without a body`)
    return
  }
  assertText(entry.value, `payload.documents[${index}].value`, 64 * 1024 * 1024)
  if (!SHA256_PATTERN.test(entry.valueSha256) || contentHash(Buffer.from(entry.value, 'utf8')) !== entry.valueSha256) {
    fail('PROJECT_PACKAGE_HASH_MISMATCH', `Mode document hash mismatch: ${entry.documentId}`, 409)
  }
  const normalized = validateWorkspaceModeDocument(entry.modeId, entry.value, entry.documentId)
  const parsed = JSON.parse(normalized)
  if ((entry.modeId === 'balanced' || entry.modeId === 'pixel') && parsed.revision !== entry.revision) {
    fail('INVALID_AEONQUILL_PACKAGE', `Mode document revision mismatch: ${entry.documentId}`)
  }
}

function validateAssetEntry(asset, index) {
  exactKeys(asset, ['id', 'sha256', 'mimeType', 'extension', 'bytes', 'path', 'provenance', 'createdAt', 'dataBase64'], `payload.assets[${index}]`)
  if (!ASSET_ID_PATTERN.test(asset.id) || asset.sha256 !== asset.id) {
    fail('INVALID_AEONQUILL_PACKAGE', `Asset identity is invalid at payload.assets[${index}]`)
  }
  const extension = MIME_EXTENSIONS.get(asset.mimeType)
  if (!extension || asset.extension !== extension || asset.path !== canonicalAssetPath(asset.id, extension)) {
    fail('UNSAFE_PROJECT_PACKAGE_PATH', `Asset path or media metadata is invalid: ${String(asset.path)}`, 400)
  }
  assertInteger(asset.bytes, `payload.assets[${index}].bytes`, 1)
  if (asset.bytes > MAX_ASSET_BYTES || !isRecord(asset.provenance)) {
    fail('INVALID_AEONQUILL_PACKAGE', `Asset metadata is invalid: ${asset.id}`)
  }
  assertInteger(asset.createdAt, `payload.assets[${index}].createdAt`)
  const bytes = validateBase64(asset.dataBase64, `payload.assets[${index}].dataBase64`)
  if (bytes.length !== asset.bytes || contentHash(bytes) !== asset.sha256) {
    fail('PROJECT_PACKAGE_HASH_MISMATCH', `Asset hash mismatch: ${asset.id}`, 409)
  }
  return { ...asset, content: bytes }
}

function validateLibrary(library, assetIds, projectId) {
  exactKeys(library, ['collections', 'items', 'versions', 'tags', 'memberships', 'references'], 'payload.library')
  for (const key of ['collections', 'items', 'versions', 'tags', 'memberships', 'references']) {
    if (!Array.isArray(library[key])) fail('INVALID_AEONQUILL_PACKAGE', `payload.library.${key} must be an array`)
  }
  const collectionIds = new Set()
  library.collections.forEach((collection, index) => {
    exactKeys(collection, ['id', 'scope', 'projectId', 'title', 'createdAt', 'updatedAt'], `payload.library.collections[${index}]`)
    assertLibraryId(collection.id, `payload.library.collections[${index}].id`)
    if (collection.scope !== 'project') fail('INVALID_AEONQUILL_PACKAGE', 'Only project collections belong in a project package')
    assertId(collection.projectId, `payload.library.collections[${index}].projectId`)
    if (collection.projectId !== projectId) fail('INVALID_AEONQUILL_PACKAGE', 'Project collection belongs to another project')
    assertText(collection.title, `payload.library.collections[${index}].title`, 80)
    assertInteger(collection.createdAt, `payload.library.collections[${index}].createdAt`)
    assertInteger(collection.updatedAt, `payload.library.collections[${index}].updatedAt`)
    if (collectionIds.has(collection.id)) fail('INVALID_AEONQUILL_PACKAGE', `Duplicate collection id: ${collection.id}`)
    collectionIds.add(collection.id)
  })
  const itemIds = new Set()
  library.items.forEach((item, index) => {
    exactKeys(item, ['id', 'scope', 'projectId', 'title', 'description', 'mediaKind', 'sourceItemId', 'createdAt', 'updatedAt'], `payload.library.items[${index}]`)
    assertLibraryId(item.id, `payload.library.items[${index}].id`)
    if (!['global', 'project'].includes(item.scope)) fail('INVALID_AEONQUILL_PACKAGE', `Invalid library scope: ${item.scope}`)
    if (item.scope === 'project') assertId(item.projectId, `payload.library.items[${index}].projectId`)
    else if (item.projectId !== null) fail('INVALID_AEONQUILL_PACKAGE', 'Global library items cannot carry a project id')
    if (item.scope === 'project' && item.projectId !== projectId) fail('INVALID_AEONQUILL_PACKAGE', 'Project library item belongs to another project')
    assertText(item.title, `payload.library.items[${index}].title`, 120)
    assertText(item.description, `payload.library.items[${index}].description`, 600)
    if (!['image', 'video', 'audio'].includes(item.mediaKind)) fail('INVALID_AEONQUILL_PACKAGE', `Invalid media kind: ${item.mediaKind}`)
    if (item.sourceItemId !== null) assertLibraryId(item.sourceItemId, `payload.library.items[${index}].sourceItemId`)
    assertInteger(item.createdAt, `payload.library.items[${index}].createdAt`)
    assertInteger(item.updatedAt, `payload.library.items[${index}].updatedAt`)
    if (itemIds.has(item.id)) fail('INVALID_AEONQUILL_PACKAGE', `Duplicate library item id: ${item.id}`)
    itemIds.add(item.id)
  })
  for (const item of library.items) {
    if (item.sourceItemId !== null && (!itemIds.has(item.sourceItemId) || item.sourceItemId === item.id)) {
      fail('INVALID_AEONQUILL_PACKAGE', `Library source item is absent or recursive: ${item.id}`)
    }
  }
  const versionIds = new Set()
  library.versions.forEach((version, index) => {
    exactKeys(version, ['id', 'itemId', 'version', 'assetId', 'parentVersionId', 'provenance', 'createdAt'], `payload.library.versions[${index}]`)
    if (!LIBRARY_VERSION_ID_PATTERN.test(version.id)) fail('INVALID_AEONQUILL_PACKAGE', `Invalid library version id: ${version.id}`)
    if (!itemIds.has(version.itemId) || !assetIds.has(version.assetId)) fail('INVALID_AEONQUILL_PACKAGE', `Library version reference is missing: ${version.id}`)
    assertInteger(version.version, `payload.library.versions[${index}].version`, 1)
    if (version.parentVersionId !== null && !LIBRARY_VERSION_ID_PATTERN.test(version.parentVersionId)) {
      fail('INVALID_AEONQUILL_PACKAGE', `Invalid library parent version: ${version.id}`)
    }
    if (!isRecord(version.provenance)) fail('INVALID_AEONQUILL_PACKAGE', `Library provenance is invalid: ${version.id}`)
    assertInteger(version.createdAt, `payload.library.versions[${index}].createdAt`)
    if (versionIds.has(version.id)) fail('INVALID_AEONQUILL_PACKAGE', `Duplicate library version id: ${version.id}`)
    versionIds.add(version.id)
  })
  for (const version of library.versions) {
    if (version.parentVersionId !== null && !versionIds.has(version.parentVersionId)) {
      fail('INVALID_AEONQUILL_PACKAGE', `Library version parent is absent: ${version.parentVersionId}`)
    }
  }
  library.tags.forEach((tag, index) => {
    exactKeys(tag, ['itemId', 'tag'], `payload.library.tags[${index}]`)
    if (!itemIds.has(tag.itemId)) fail('INVALID_AEONQUILL_PACKAGE', `Library tag item is absent: ${tag.itemId}`)
    assertText(tag.tag, `payload.library.tags[${index}].tag`, 40)
  })
  library.memberships.forEach((membership, index) => {
    exactKeys(membership, ['collectionId', 'itemId'], `payload.library.memberships[${index}]`)
    if (!collectionIds.has(membership.collectionId) || !itemIds.has(membership.itemId)) {
      fail('INVALID_AEONQUILL_PACKAGE', 'Library collection membership is incomplete')
    }
  })
  library.references.forEach((reference, index) => {
    exactKeys(reference, ['projectId', 'itemId', 'versionId', 'createdAt'], `payload.library.references[${index}]`)
    assertId(reference.projectId, `payload.library.references[${index}].projectId`)
    if (reference.projectId !== projectId) fail('INVALID_AEONQUILL_PACKAGE', 'Library reference belongs to another project')
    if (!itemIds.has(reference.itemId) || !versionIds.has(reference.versionId)) {
      fail('INVALID_AEONQUILL_PACKAGE', 'Library project reference is incomplete')
    }
    assertInteger(reference.createdAt, `payload.library.references[${index}].createdAt`)
  })
}

function validatePayload(payload) {
  exactKeys(payload, ['project', 'documents', 'recoveryPoints', 'balancedProjects', 'library', 'assets'], 'payload')
  let project
  try {
    project = assertProjectCatalog({
      schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION,
      revision: 0,
      projects: [payload.project],
    }).projects[0]
  } catch (error) {
    fail(error?.code || 'INVALID_AEONQUILL_PACKAGE', error?.message || 'Project registration is invalid')
  }
  if (!Array.isArray(payload.documents) || payload.documents.length !== project.documents.length) {
    fail('INVALID_AEONQUILL_PACKAGE', 'Package must contain one entry for every registered mode document')
  }
  project.documents.forEach((registration, index) => validateDocumentEntry(payload.documents[index], registration, index))
  if (!Array.isArray(payload.assets)) fail('INVALID_AEONQUILL_PACKAGE', 'payload.assets must be an array')
  const stagedAssets = payload.assets.map(validateAssetEntry)
  const assetIds = new Set()
  for (const asset of stagedAssets) {
    if (assetIds.has(asset.id)) fail('INVALID_AEONQUILL_PACKAGE', `Duplicate asset id: ${asset.id}`)
    assetIds.add(asset.id)
  }
  if (!Array.isArray(payload.balancedProjects)) fail('INVALID_AEONQUILL_PACKAGE', 'payload.balancedProjects must be an array')
  const balancedIds = new Set()
  payload.balancedProjects.forEach((entry, index) => {
    exactKeys(entry, ['documentId', 'title', 'schemaVersion', 'revision', 'document', 'createdAt', 'updatedAt', 'assetVersions'], `payload.balancedProjects[${index}]`)
    assertId(entry.documentId, `payload.balancedProjects[${index}].documentId`)
    if (balancedIds.has(entry.documentId)) fail('INVALID_AEONQUILL_PACKAGE', `Duplicate balanced document: ${entry.documentId}`)
    balancedIds.add(entry.documentId)
    const registration = project.documents.find(({ id }) => id === entry.documentId)
    if (!registration || registration.modeId !== 'balanced') fail('INVALID_AEONQUILL_PACKAGE', `Balanced metadata is not registered: ${entry.documentId}`)
    try { assertCanvasDocument(entry.document) } catch (error) {
      fail(error?.code || 'INVALID_AEONQUILL_PACKAGE', error?.message || `Balanced document is invalid: ${entry.documentId}`)
    }
    if (entry.document.id !== entry.documentId || entry.revision !== registration.revision || entry.document.revision !== registration.revision) {
      fail('INVALID_AEONQUILL_PACKAGE', `Balanced document identity or revision mismatch: ${entry.documentId}`)
    }
    const workspaceBody = payload.documents.find(({ documentId }) => documentId === entry.documentId)?.value
    if (workspaceBody === null || workspaceBody === undefined || JSON.stringify(JSON.parse(workspaceBody)) !== JSON.stringify(entry.document)) {
      fail('INVALID_AEONQUILL_PACKAGE', `Balanced workspace body and asset metadata disagree: ${entry.documentId}`)
    }
    assertText(entry.title, `payload.balancedProjects[${index}].title`, 120)
    assertInteger(entry.schemaVersion, `payload.balancedProjects[${index}].schemaVersion`, 1)
    assertInteger(entry.createdAt, `payload.balancedProjects[${index}].createdAt`)
    assertInteger(entry.updatedAt, `payload.balancedProjects[${index}].updatedAt`)
    if (!Array.isArray(entry.assetVersions)) fail('INVALID_AEONQUILL_PACKAGE', 'Balanced asset versions must be an array')
    const versionIds = new Set()
    entry.assetVersions.forEach((version, versionIndex) => {
      exactKeys(version, ['id', 'logicalAssetId', 'version', 'assetId', 'parentVersionId', 'sourceElementId', 'provenance', 'createdAt'], `payload.balancedProjects[${index}].assetVersions[${versionIndex}]`)
      if (!ASSET_VERSION_ID_PATTERN.test(version.id) || !assetIds.has(version.assetId)) fail('INVALID_AEONQUILL_PACKAGE', `Balanced asset version is invalid: ${version.id}`)
      assertText(version.logicalAssetId, 'logicalAssetId', 240)
      assertInteger(version.version, 'assetVersion.version', 1)
      if (version.parentVersionId !== null && !ASSET_VERSION_ID_PATTERN.test(version.parentVersionId)) fail('INVALID_AEONQUILL_PACKAGE', `Invalid balanced asset parent: ${version.id}`)
      if (version.sourceElementId !== null) assertText(version.sourceElementId, 'sourceElementId', 240)
      if (!isRecord(version.provenance)) fail('INVALID_AEONQUILL_PACKAGE', `Balanced asset provenance is invalid: ${version.id}`)
      assertInteger(version.createdAt, 'assetVersion.createdAt')
      if (versionIds.has(version.id)) fail('INVALID_AEONQUILL_PACKAGE', `Duplicate balanced asset version: ${version.id}`)
      versionIds.add(version.id)
    })
    for (const version of entry.assetVersions) {
      if (version.parentVersionId !== null && !versionIds.has(version.parentVersionId)) fail('INVALID_AEONQUILL_PACKAGE', `Balanced asset parent is absent: ${version.parentVersionId}`)
    }
  })
  if (!Array.isArray(payload.recoveryPoints)) fail('INVALID_AEONQUILL_PACKAGE', 'payload.recoveryPoints must be an array')
  const recoveryIds = new Set()
  payload.recoveryPoints.forEach((recovery, index) => {
    exactKeys(recovery, ['id', 'projectId', 'documentId', 'modeId', 'catalogRevision', 'documentRevision', 'project', 'body', 'reason', 'createdAt'], `payload.recoveryPoints[${index}]`)
    assertId(recovery.id, `payload.recoveryPoints[${index}].id`)
    if (recovery.projectId !== project.id || recovery.project.id !== project.id) fail('INVALID_AEONQUILL_PACKAGE', `Recovery project mismatch: ${recovery.id}`)
    let recoveryProject
    try {
      recoveryProject = assertProjectCatalog({
        schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION,
        revision: 0,
        projects: [recovery.project],
      }).projects[0]
    } catch (error) {
      fail(error?.code || 'INVALID_AEONQUILL_PACKAGE', error?.message || `Recovery project is invalid: ${recovery.id}`)
    }
    if (recovery.documentId !== null) {
      const registration = recoveryProject.documents.find(({ id }) => id === recovery.documentId)
      if (!registration || registration.modeId !== recovery.modeId || recovery.body === null) fail('INVALID_AEONQUILL_PACKAGE', `Recovery document mismatch: ${recovery.id}`)
      validateWorkspaceModeDocument(recovery.modeId, recovery.body, recovery.documentId)
      assertInteger(recovery.documentRevision, `payload.recoveryPoints[${index}].documentRevision`)
    } else if (recovery.modeId !== null || recovery.documentRevision !== null || recovery.body !== null) {
      fail('INVALID_AEONQUILL_PACKAGE', `Catalog recovery fields are inconsistent: ${recovery.id}`)
    }
    assertInteger(recovery.catalogRevision, `payload.recoveryPoints[${index}].catalogRevision`)
    assertText(recovery.reason, `payload.recoveryPoints[${index}].reason`, 120)
    assertInteger(recovery.createdAt, `payload.recoveryPoints[${index}].createdAt`)
    if (recoveryIds.has(recovery.id)) fail('INVALID_AEONQUILL_PACKAGE', `Duplicate recovery id: ${recovery.id}`)
    recoveryIds.add(recovery.id)
  })
  validateLibrary(payload.library, assetIds, project.id)
  const referencedAssets = new Set()
  collectAssetReferences(payload.documents, referencedAssets)
  collectAssetReferences(payload.recoveryPoints, referencedAssets)
  collectAssetReferences(payload.balancedProjects, referencedAssets)
  for (const version of payload.library.versions) referencedAssets.add(version.assetId)
  for (const assetId of referencedAssets) {
    if (!assetIds.has(assetId)) fail('PROJECT_PACKAGE_ASSET_MISSING', `Package is missing referenced asset: ${assetId}`, 409)
  }
  return { payload: { ...payload, project }, stagedAssets }
}

function remapModeBody(modeId, value, documentId) {
  if (value === null) return null
  const parsed = JSON.parse(value)
  if (modeId === 'balanced' || modeId === 'pixel') parsed.id = documentId
  else {
    parsed.project.id = documentId
    parsed.plan.projectId = documentId
  }
  return validateWorkspaceModeDocument(modeId, JSON.stringify(parsed), documentId)
}

function remapProject(project, projectId, documentIds, now, copied) {
  const mapped = {
    ...clone(project),
    id: projectId,
    title: copied ? safeTitle(project.title, '（导入副本）') : project.title,
    status: 'active',
    updatedAt: Math.max(project.updatedAt, now),
    lastOpenedAt: now,
    trashedAt: null,
    documents: project.documents.map((document) => ({
      ...document,
      id: documentIds.get(document.id),
      updatedAt: Math.max(document.updatedAt, now),
    })),
  }
  return assertProjectCatalog({ schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION, revision: 0, projects: [mapped] }).projects[0]
}

async function availableBytesAt(path) {
  try {
    const stats = await statfs(path)
    return Number(BigInt(stats.bavail) * BigInt(stats.bsize))
  } catch {
    return null
  }
}

export class ProjectPackageService {
  constructor({ projectStore, workspaceStore }) {
    this.projectStore = projectStore
    this.workspaceStore = workspaceStore
  }

  assertOpen() {
    this.projectStore.assertOpen()
    this.workspaceStore.assertOpen()
  }

  workspaceSnapshot(projectId) {
    const catalogRecord = this.workspaceStore.getCatalog()
    const project = catalogRecord.catalog.projects.find(({ id }) => id === projectId)
    if (!project) fail('WORKSPACE_PROJECT_NOT_FOUND', `Workspace project was not found: ${projectId}`, 404)
    const documents = project.documents.map((registration) => {
      const row = this.workspaceStore.getModeDocument(registration.id)
      if (row && (row.projectId !== projectId || row.modeId !== registration.modeId || row.revision !== registration.revision)) {
        fail('PROJECT_PACKAGE_SOURCE_CORRUPT', `Workspace document registration drifted: ${registration.id}`, 409)
      }
      return {
        documentId: registration.id,
        modeId: registration.modeId,
        revision: registration.revision,
        value: row?.value ?? null,
        valueSha256: row ? contentHash(Buffer.from(row.value, 'utf8')) : null,
        createdAt: row?.createdAt ?? registration.createdAt,
        updatedAt: row?.updatedAt ?? registration.updatedAt,
      }
    })
    const recoveryPoints = this.workspaceStore.database.prepare(`
      SELECT id, project_id AS projectId, document_id AS documentId, mode_id AS modeId,
             catalog_revision AS catalogRevision, document_revision AS documentRevision,
             project_json AS projectJson, body_json AS body, reason, created_at AS createdAt
      FROM recovery_points WHERE project_id = ? ORDER BY created_at ASC, id ASC
    `).all(projectId).map((row) => ({
      id: row.id,
      projectId: row.projectId,
      documentId: row.documentId ?? null,
      modeId: row.modeId ?? null,
      catalogRevision: Number(row.catalogRevision),
      documentRevision: row.documentRevision === null ? null : Number(row.documentRevision),
      project: rowJson(row.projectJson, `Recovery point ${row.id}`),
      body: row.body ?? null,
      reason: row.reason,
      createdAt: Number(row.createdAt),
    }))
    return { catalogRecord, project: clone(project), documents, recoveryPoints }
  }

  librarySnapshot(projectId) {
    const database = this.projectStore.database
    const initialRows = database.prepare(`
      SELECT DISTINCT i.id, i.scope, i.project_id AS projectId, i.title, i.description,
             i.media_kind AS mediaKind, i.source_item_id AS sourceItemId,
             i.created_at AS createdAt, i.updated_at AS updatedAt
      FROM library_items i
      LEFT JOIN library_project_refs r ON r.item_id = i.id AND r.project_id = ?
      WHERE (i.scope = 'project' AND i.project_id = ?) OR r.project_id = ?
      ORDER BY i.created_at ASC, i.id ASC
    `).all(projectId, projectId, projectId)
    const rowsById = new Map(initialRows.map((row) => [row.id, row]))
    const pending = initialRows.map(({ sourceItemId }) => sourceItemId).filter(Boolean)
    while (pending.length) {
      const itemId = pending.pop()
      if (rowsById.has(itemId)) continue
      const row = database.prepare(`
        SELECT id, scope, project_id AS projectId, title, description, media_kind AS mediaKind,
               source_item_id AS sourceItemId, created_at AS createdAt, updated_at AS updatedAt
        FROM library_items WHERE id = ?
      `).get(itemId)
      if (!row) continue
      rowsById.set(row.id, row)
      if (row.sourceItemId) pending.push(row.sourceItemId)
    }
    const items = [...rowsById.values()].map((row) => ({
      id: row.id,
      scope: row.scope,
      projectId: row.projectId ?? null,
      title: row.title,
      description: row.description,
      mediaKind: row.mediaKind,
      sourceItemId: row.sourceItemId ?? null,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    }))
    const itemIds = new Set(items.map(({ id }) => id))
    const versions = database.prepare(`
      SELECT id, item_id AS itemId, version, asset_id AS assetId,
             parent_version_id AS parentVersionId, provenance_json AS provenanceJson,
             created_at AS createdAt
      FROM library_versions ORDER BY item_id ASC, version ASC, id ASC
    `).all().filter(({ itemId }) => itemIds.has(itemId)).map((row) => ({
      id: row.id,
      itemId: row.itemId,
      version: Number(row.version),
      assetId: row.assetId,
      parentVersionId: row.parentVersionId ?? null,
      provenance: rowJson(row.provenanceJson, `Library version ${row.id}`),
      createdAt: Number(row.createdAt),
    }))
    const versionIds = new Set(versions.map(({ id }) => id))
    const tags = database.prepare('SELECT item_id AS itemId, tag FROM library_tags ORDER BY item_id ASC, tag ASC')
      .all().filter(({ itemId }) => itemIds.has(itemId))
    const collections = database.prepare(`
      SELECT id, scope, project_id AS projectId, title, created_at AS createdAt, updated_at AS updatedAt
      FROM library_collections WHERE scope = 'project' AND project_id = ? ORDER BY created_at ASC, id ASC
    `).all(projectId).map((row) => ({ ...row, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) }))
    const collectionIds = new Set(collections.map(({ id }) => id))
    const memberships = database.prepare(`
      SELECT collection_id AS collectionId, item_id AS itemId
      FROM library_collection_items ORDER BY collection_id ASC, item_id ASC
    `).all().filter(({ collectionId, itemId }) => collectionIds.has(collectionId) && itemIds.has(itemId))
    const references = database.prepare(`
      SELECT project_id AS projectId, item_id AS itemId, version_id AS versionId, created_at AS createdAt
      FROM library_project_refs WHERE project_id = ? ORDER BY created_at ASC, item_id ASC
    `).all(projectId).map((row) => ({ ...row, createdAt: Number(row.createdAt) }))
    for (const reference of references) {
      if (!itemIds.has(reference.itemId) || !versionIds.has(reference.versionId)) {
        fail('PROJECT_PACKAGE_SOURCE_CORRUPT', `Library reference is incomplete: ${reference.itemId}`, 409)
      }
    }
    return { collections, items, versions, tags, memberships, references }
  }

  async buildPayload(projectId, options = {}) {
    this.assertOpen()
    assertId(projectId, 'projectId')
    const workspace = this.workspaceSnapshot(projectId)
    const balancedProjects = workspace.documents.filter(({ modeId, value }) => modeId === 'balanced' && value !== null).map((entry) => {
      const document = JSON.parse(entry.value)
      return {
        documentId: entry.documentId,
        title: document.title,
        schemaVersion: document.schemaVersion,
        revision: document.revision,
        document,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        assetVersions: this.projectStore.listProjectAssetVersions(entry.documentId).map((version) => ({
          ...version,
          parentVersionId: version.parentVersionId ?? null,
          sourceElementId: version.sourceElementId ?? null,
        })),
      }
    })
    const library = this.librarySnapshot(projectId)
    const assetIds = new Set()
    collectAssetReferences(workspace.documents, assetIds)
    collectAssetReferences(workspace.recoveryPoints, assetIds)
    for (const balanced of balancedProjects) {
      collectAssetReferences(balanced.document, assetIds)
      for (const version of balanced.assetVersions) assetIds.add(version.assetId)
      for (const asset of this.projectStore.listProjectAssets(balanced.documentId)) assetIds.add(asset.id)
    }
    for (const version of library.versions) assetIds.add(version.assetId)
    const assets = []
    for (const assetId of [...assetIds].sort()) {
      const asset = this.projectStore.getAsset(assetId)
      if (!asset) fail('PROJECT_PACKAGE_ASSET_MISSING', `Referenced asset is absent: ${assetId}`, 409)
      const bytes = await readFile(this.projectStore.assetPath(asset))
      if (bytes.length !== asset.bytes || contentHash(bytes) !== asset.sha256) {
        fail('PROJECT_PACKAGE_HASH_MISMATCH', `Stored asset failed integrity validation: ${assetId}`, 409)
      }
      assets.push({
        id: asset.id,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
        extension: asset.extension,
        bytes: asset.bytes,
        path: canonicalAssetPath(asset.id, asset.extension),
        provenance: asset.provenance,
        createdAt: asset.createdAt,
        dataBase64: bytes.toString('base64'),
      })
    }
    return {
      project: workspace.project,
      documents: workspace.documents,
      recoveryPoints: workspace.recoveryPoints,
      balancedProjects,
      library,
      assets,
      exportedAt: options.now ?? Date.now(),
    }
  }

  async previewExport(projectId) {
    const { exportedAt: _exportedAt, ...payload } = await this.buildPayload(projectId)
    const rawBytes = Buffer.byteLength(JSON.stringify(payload))
    return packagePreview(payload, { rawBytes })
  }

  async exportBundle(projectId, options = {}) {
    const built = await this.buildPayload(projectId, options)
    const { exportedAt, ...payload } = built
    validatePayload(payload)
    const envelope = {
      magic: AEONQUILL_PACKAGE_MAGIC,
      packageSchemaVersion: AEONQUILL_PACKAGE_SCHEMA_VERSION,
      exportedAt,
      payloadSha256: jsonHash(payload),
      payload,
    }
    const encoded = Buffer.from(JSON.stringify(envelope), 'utf8')
    if (encoded.length > MAX_PACKAGE_BYTES) fail('PROJECT_PACKAGE_LIMIT', 'AEONQUILL project package exceeds 384MB before compression', 413)
    const body = await gzipAsync(encoded, { level: 6 })
    if (body.length > MAX_PACKAGE_BYTES) fail('PROJECT_PACKAGE_LIMIT', 'AEONQUILL project package exceeds 384MB', 413)
    return { body, preview: packagePreview(payload, { rawBytes: encoded.length, archiveBytes: body.length }) }
  }

  async inspectBundle(bundle) {
    if (!Buffer.isBuffer(bundle) || !bundle.length || bundle.length > MAX_PACKAGE_BYTES) {
      fail('PROJECT_PACKAGE_LIMIT', 'Project package is empty or exceeds 384MB', 413)
    }
    let decoded
    try {
      decoded = await gunzipAsync(bundle, { maxOutputLength: MAX_PACKAGE_BYTES })
    } catch {
      fail('INVALID_AEONQUILL_PACKAGE', 'Project package is not a valid gzip archive')
    }
    let envelope
    try {
      envelope = JSON.parse(decoded.toString('utf8'))
    } catch {
      fail('INVALID_AEONQUILL_PACKAGE', 'Project package manifest is invalid JSON')
    }
    if (envelope?.magic !== AEONQUILL_PACKAGE_MAGIC) {
      if (
        envelope?.packageSchemaVersion === 1
        && isRecord(envelope.project)
        && isRecord(envelope.project.document)
        && Array.isArray(envelope.assets)
      ) {
        return { kind: 'legacy', legacyPayload: envelope, preview: legacyPreview(envelope, bundle.length) }
      }
      fail('INVALID_AEONQUILL_PACKAGE', 'Project package magic is missing or unsupported')
    }
    exactKeys(envelope, ['magic', 'packageSchemaVersion', 'exportedAt', 'payloadSha256', 'payload'], 'package')
    if (envelope.packageSchemaVersion !== AEONQUILL_PACKAGE_SCHEMA_VERSION) {
      fail('UNSUPPORTED_AEONQUILL_PACKAGE_SCHEMA', `Unsupported AEONQUILL package schema: ${String(envelope.packageSchemaVersion)}`, 409)
    }
    assertInteger(envelope.exportedAt, 'package.exportedAt')
    if (!SHA256_PATTERN.test(envelope.payloadSha256) || jsonHash(envelope.payload) !== envelope.payloadSha256) {
      fail('PROJECT_PACKAGE_HASH_MISMATCH', 'AEONQUILL package payload hash mismatch', 409)
    }
    const validated = validatePayload(envelope.payload)
    return {
      kind: 'complete',
      payload: validated.payload,
      stagedAssets: validated.stagedAssets,
      preview: packagePreview(validated.payload, { rawBytes: decoded.length, archiveBytes: bundle.length }),
    }
  }

  async previewImport(bundle) {
    const inspected = await this.inspectBundle(bundle)
    const projectId = inspected.kind === 'complete' ? inspected.payload.project.id : inspected.preview.project.id
    const catalog = this.workspaceStore.getCatalog().catalog
    const conflicts = []
    if (catalog.projects.some(({ id }) => id === projectId)) conflicts.push({ kind: 'project', id: projectId })
    if (inspected.kind === 'complete') {
      const registeredDocumentIds = new Set(catalog.projects.flatMap(({ documents }) => documents.map(({ id }) => id)))
      for (const document of inspected.payload.project.documents) {
        if (registeredDocumentIds.has(document.id) || this.projectStore.getProject(document.id)) {
          conflicts.push({ kind: 'document', id: document.id })
        }
      }
    }
    return { ...inspected.preview, conflicts }
  }

  buildImportPlan(payload, options = {}) {
    const conflictPolicy = options.conflictPolicy || 'reject'
    if (!['reject', 'copy'].includes(conflictPolicy)) fail('INVALID_PROJECT_PACKAGE_CONFLICT_POLICY', 'Conflict policy must be reject or copy')
    const now = options.now ?? Date.now()
    const catalogRecord = this.workspaceStore.getCatalog()
    const occupiedProjects = new Set(catalogRecord.catalog.projects.map(({ id }) => id))
    const occupiedDocuments = new Set(catalogRecord.catalog.projects.flatMap(({ documents }) => documents.map(({ id }) => id)))
    for (const row of this.projectStore.database.prepare('SELECT id FROM projects').all()) occupiedDocuments.add(row.id)
    const requestedProjectId = options.projectId === undefined ? payload.project.id : assertId(options.projectId, 'projectId')
    const projectFootprint = occupiedProjects.has(requestedProjectId)
      || Boolean(this.projectStore.database.prepare(`SELECT 1 AS found FROM library_items WHERE project_id = ? LIMIT 1`).get(requestedProjectId))
      || Boolean(this.projectStore.database.prepare(`SELECT 1 AS found FROM library_project_refs WHERE project_id = ? LIMIT 1`).get(requestedProjectId))
    if (projectFootprint && conflictPolicy === 'reject') {
      fail('PROJECT_PACKAGE_ID_CONFLICT', `Project id already exists: ${requestedProjectId}`, 409, { projectId: requestedProjectId })
    }
    const targetProjectId = projectFootprint
      ? uniqueId('project-import', occupiedProjects)
      : requestedProjectId
    occupiedProjects.add(targetProjectId)
    const documentIds = new Map()
    for (const document of payload.project.documents) {
      const collision = occupiedDocuments.has(document.id) || projectFootprint
      if (collision && conflictPolicy === 'reject') {
        fail('PROJECT_PACKAGE_ID_CONFLICT', `Document id already exists: ${document.id}`, 409, { documentId: document.id })
      }
      documentIds.set(document.id, collision ? uniqueId(`document-${document.modeId}`, occupiedDocuments) : document.id)
      occupiedDocuments.add(documentIds.get(document.id))
    }
    for (const recovery of payload.recoveryPoints) {
      for (const document of recovery.project.documents) {
        if (documentIds.has(document.id)) continue
        const collision = occupiedDocuments.has(document.id) || projectFootprint
        if (collision && conflictPolicy === 'reject') {
          fail('PROJECT_PACKAGE_ID_CONFLICT', `Recovery document id already exists: ${document.id}`, 409, { documentId: document.id })
        }
        documentIds.set(document.id, collision ? uniqueId(`document-${document.modeId}`, occupiedDocuments) : document.id)
        occupiedDocuments.add(documentIds.get(document.id))
      }
    }
    const existingItemIds = new Set(this.projectStore.database.prepare('SELECT id FROM library_items').all().map(({ id }) => id))
    const itemIds = new Map()
    for (const item of payload.library.items) {
      if (existingItemIds.has(item.id) && conflictPolicy === 'reject') {
        fail('PROJECT_PACKAGE_LIBRARY_CONFLICT', `Library item id already exists: ${item.id}`, 409)
      }
      itemIds.set(item.id, existingItemIds.has(item.id) ? uniqueId('library-import', existingItemIds) : item.id)
      existingItemIds.add(itemIds.get(item.id))
    }
    const existingCollectionIds = new Set(this.projectStore.database.prepare('SELECT id FROM library_collections').all().map(({ id }) => id))
    const collectionIds = new Map()
    for (const collection of payload.library.collections) {
      if (existingCollectionIds.has(collection.id) && conflictPolicy === 'reject') {
        fail('PROJECT_PACKAGE_LIBRARY_CONFLICT', `Library collection id already exists: ${collection.id}`, 409)
      }
      collectionIds.set(collection.id, existingCollectionIds.has(collection.id) ? uniqueId('collection-import', existingCollectionIds) : collection.id)
      existingCollectionIds.add(collectionIds.get(collection.id))
    }
    const versionIds = new Map()
    for (const version of payload.library.versions) {
      versionIds.set(version.id, libraryVersionId(itemIds.get(version.itemId), version.version, version.assetId))
    }
    const project = remapProject(payload.project, targetProjectId, documentIds, now, projectFootprint)
    const documents = payload.documents.map((entry) => ({
      ...entry,
      documentId: documentIds.get(entry.documentId),
      value: remapModeBody(entry.modeId, entry.value, documentIds.get(entry.documentId)),
      valueSha256: entry.value === null ? null : undefined,
      updatedAt: Math.max(entry.updatedAt, now),
    })).map((entry) => ({
      ...entry,
      valueSha256: entry.value === null ? null : contentHash(Buffer.from(entry.value, 'utf8')),
    }))
    const recoveryPoints = payload.recoveryPoints.map((recovery) => {
      const mappedDocumentId = recovery.documentId === null ? null : documentIds.get(recovery.documentId)
      const mappedProject = remapProject(recovery.project, targetProjectId, documentIds, now, projectFootprint)
      return {
        ...recovery,
        id: `recovery-${randomUUID()}`,
        projectId: targetProjectId,
        documentId: mappedDocumentId,
        project: mappedProject,
        body: recovery.body === null ? null : remapModeBody(recovery.modeId, recovery.body, mappedDocumentId),
      }
    })
    const balancedProjects = payload.balancedProjects.map((balanced) => {
      const documentId = documentIds.get(balanced.documentId)
      const documentEntry = documents.find((entry) => entry.documentId === documentId)
      const document = documentEntry ? JSON.parse(documentEntry.value) : { ...balanced.document, id: documentId }
      return { ...balanced, documentId, document, revision: document.revision, title: document.title }
    })
    const library = {
      collections: payload.library.collections.map((collection) => ({
        ...collection,
        id: collectionIds.get(collection.id),
        projectId: targetProjectId,
      })),
      items: payload.library.items.map((item) => ({
        ...item,
        id: itemIds.get(item.id),
        projectId: item.scope === 'project' ? targetProjectId : null,
        sourceItemId: item.sourceItemId === null ? null : itemIds.get(item.sourceItemId) ?? null,
      })),
      versions: payload.library.versions.map((version) => ({
        ...version,
        id: versionIds.get(version.id),
        itemId: itemIds.get(version.itemId),
        parentVersionId: version.parentVersionId === null ? null : versionIds.get(version.parentVersionId) ?? null,
      })),
      tags: payload.library.tags.map((tag) => ({ ...tag, itemId: itemIds.get(tag.itemId) })),
      memberships: payload.library.memberships.map((membership) => ({
        collectionId: collectionIds.get(membership.collectionId),
        itemId: itemIds.get(membership.itemId),
      })),
      references: payload.library.references.map((reference) => ({
        ...reference,
        projectId: targetProjectId,
        itemId: itemIds.get(reference.itemId),
        versionId: versionIds.get(reference.versionId),
      })),
    }
    return {
      baseCatalogRevision: catalogRecord.catalog.revision,
      now,
      copied: projectFootprint,
      project,
      documents,
      recoveryPoints,
      balancedProjects,
      library,
      idMap: {
        projectId: { [payload.project.id]: targetProjectId },
        documentIds: Object.fromEntries(documentIds),
        libraryItemIds: Object.fromEntries(itemIds),
        collectionIds: Object.fromEntries(collectionIds),
      },
    }
  }

  writeProjectMetadata(plan, stagedAssets) {
    const database = this.projectStore.database
    const now = plan.now
    const insertAsset = database.prepare(`
      INSERT OR IGNORE INTO assets
        (id, sha256, mime_type, extension, bytes, relative_path, provenance_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const asset of stagedAssets) {
      insertAsset.run(asset.id, asset.sha256, asset.mimeType, asset.extension, asset.bytes,
        basename(asset.path), JSON.stringify(asset.provenance), asset.createdAt)
    }
    const insertProject = database.prepare(`
      INSERT INTO projects (id, title, schema_version, revision, document_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const insertProjectAsset = database.prepare(`INSERT INTO project_assets (project_id, asset_id, role) VALUES (?, ?, 'document')`)
    const insertAssetVersion = database.prepare(`
      INSERT INTO asset_versions
        (project_id, id, logical_asset_id, version, asset_id, parent_version_id,
         source_element_id, provenance_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const balanced of plan.balancedProjects) {
      insertProject.run(balanced.documentId, balanced.title, balanced.schemaVersion, balanced.revision,
        JSON.stringify(balanced.document), balanced.createdAt, Math.max(balanced.updatedAt, now))
      const assetIds = new Set()
      collectAssetReferences(balanced.document, assetIds)
      for (const version of balanced.assetVersions) {
        assetIds.add(version.assetId)
        insertAssetVersion.run(balanced.documentId, version.id, version.logicalAssetId, version.version,
          version.assetId, version.parentVersionId, version.sourceElementId,
          JSON.stringify(version.provenance), version.createdAt)
      }
      for (const assetId of assetIds) insertProjectAsset.run(balanced.documentId, assetId)
    }
    const insertCollection = database.prepare(`
      INSERT INTO library_collections (id, scope, project_id, title, created_at, updated_at)
      VALUES (?, 'project', ?, ?, ?, ?)
    `)
    for (const collection of plan.library.collections) {
      insertCollection.run(collection.id, plan.project.id, collection.title, collection.createdAt, Math.max(collection.updatedAt, now))
    }
    const insertItem = database.prepare(`
      INSERT INTO library_items
        (id, scope, project_id, title, description, media_kind, source_item_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `)
    for (const item of [...plan.library.items].sort((left, right) => left.scope === right.scope ? left.id.localeCompare(right.id) : left.scope === 'global' ? -1 : 1)) {
      insertItem.run(item.id, item.scope, item.projectId, item.title, item.description, item.mediaKind,
        item.createdAt, Math.max(item.updatedAt, now))
    }
    const updateSource = database.prepare('UPDATE library_items SET source_item_id = ? WHERE id = ?')
    for (const item of plan.library.items) if (item.sourceItemId) updateSource.run(item.sourceItemId, item.id)
    const insertLibraryVersion = database.prepare(`
      INSERT INTO library_versions
        (id, item_id, version, asset_id, parent_version_id, provenance_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const version of plan.library.versions) {
      insertLibraryVersion.run(version.id, version.itemId, version.version, version.assetId,
        version.parentVersionId, JSON.stringify(version.provenance), version.createdAt)
    }
    const insertTag = database.prepare('INSERT INTO library_tags (item_id, tag) VALUES (?, ?)')
    for (const tag of plan.library.tags) insertTag.run(tag.itemId, tag.tag)
    const insertMembership = database.prepare('INSERT INTO library_collection_items (collection_id, item_id) VALUES (?, ?)')
    for (const membership of plan.library.memberships) insertMembership.run(membership.collectionId, membership.itemId)
    const insertReference = database.prepare(`
      INSERT INTO library_project_refs (project_id, item_id, version_id, created_at) VALUES (?, ?, ?, ?)
    `)
    for (const reference of plan.library.references) {
      insertReference.run(plan.project.id, reference.itemId, reference.versionId, reference.createdAt)
    }
  }

  writeWorkspaceMetadata(plan) {
    const database = this.workspaceStore.database
    const current = this.workspaceStore.getCatalog()
    if (current.catalog.revision !== plan.baseCatalogRevision) {
      fail('WORKSPACE_CATALOG_CONFLICT', 'Workspace catalog changed while the project package was being prepared', 409)
    }
    const catalog = assertProjectCatalog({
      ...current.catalog,
      revision: current.catalog.revision + 1,
      projects: [...current.catalog.projects, plan.project],
    })
    database.prepare(`UPDATE workspace_meta SET value_json = ?, updated_at = ? WHERE key = 'project-catalog'`)
      .run(JSON.stringify(catalog), plan.now)
    const insertDocument = database.prepare(`
      INSERT INTO mode_documents
        (document_id, project_id, mode_id, revision, value_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const document of plan.documents) {
      if (document.value === null) continue
      insertDocument.run(document.documentId, plan.project.id, document.modeId, document.revision,
        document.value, document.createdAt, document.updatedAt)
    }
    const insertRecovery = database.prepare(`
      INSERT INTO recovery_points
        (id, project_id, document_id, mode_id, catalog_revision, document_revision,
         project_json, body_json, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const recovery of plan.recoveryPoints) {
      insertRecovery.run(recovery.id, plan.project.id, recovery.documentId, recovery.modeId,
        recovery.catalogRevision, recovery.documentRevision, JSON.stringify(recovery.project),
        recovery.body, recovery.reason, recovery.createdAt)
    }
    return catalog
  }

  async importComplete(inspected, options = {}) {
    const plan = this.buildImportPlan(inspected.payload, options)
    const newAssets = []
    const assetsNeedingFiles = []
    for (const asset of inspected.stagedAssets) {
      const existing = this.projectStore.getAsset(asset.id)
      const finalPath = this.projectStore.assetPath({ relativePath: basename(asset.path) })
      if (existing) {
        if (
          existing.sha256 !== asset.sha256
          || existing.mimeType !== asset.mimeType
          || existing.extension !== asset.extension
          || existing.bytes !== asset.bytes
          || existing.relativePath !== basename(asset.path)
        ) {
          fail('PROJECT_PACKAGE_ASSET_CONFLICT', `Stored asset metadata conflicts with the project package: ${asset.id}`, 409)
        }
      } else {
        newAssets.push(asset)
      }
      try {
        const bytes = await readFile(finalPath)
        if (bytes.length !== asset.bytes || contentHash(bytes) !== asset.sha256) {
          fail('PROJECT_PACKAGE_HASH_MISMATCH', `Existing content-addressed asset is corrupt: ${asset.id}`, 409)
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        assetsNeedingFiles.push({ ...asset, finalPath })
      }
    }
    const requiredBytes = assetsNeedingFiles.reduce((sum, asset) => sum + asset.bytes, 0) + (options.bundleBytes || 0) + PACKAGE_HEADROOM_BYTES
    const availableBytes = options.availableBytes ?? await availableBytesAt(this.projectStore.rootDirectory)
    if (availableBytes !== null && availableBytes < requiredBytes) {
      fail('PROJECT_PACKAGE_DISK_SPACE', 'Insufficient disk space to import the project package safely', 507, { requiredBytes, availableBytes })
    }
    const stagedFiles = []
    const finalFiles = []
    for (const asset of assetsNeedingFiles) {
      const temporaryPath = join(this.projectStore.tempDirectory, `package-${asset.id}-${randomUUID()}.tmp`)
      await writeFile(temporaryPath, asset.content, { flag: 'wx' })
      stagedFiles.push({ temporaryPath, finalPath: asset.finalPath, assetId: asset.id, sha256: asset.sha256, bytes: asset.bytes })
    }
    let projectTransaction = false
    let workspaceTransaction = false
    let projectCommitted = false
    let catalog
    try {
      this.projectStore.database.exec('BEGIN IMMEDIATE')
      projectTransaction = true
      this.workspaceStore.database.exec('BEGIN IMMEDIATE')
      workspaceTransaction = true
      this.writeProjectMetadata(plan, inspected.stagedAssets)
      catalog = this.writeWorkspaceMetadata(plan)
      if (options.interruptAt === 'after-metadata') fail('PROJECT_PACKAGE_IMPORT_INTERRUPTED', 'Injected project import interruption', 503)
      for (const staged of stagedFiles) {
        try {
          await rename(staged.temporaryPath, staged.finalPath)
          finalFiles.push(staged)
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          await unlink(staged.temporaryPath).catch(() => {})
          const bytes = await readFile(staged.finalPath)
          if (bytes.length !== staged.bytes || contentHash(bytes) !== staged.sha256) {
            fail('PROJECT_PACKAGE_HASH_MISMATCH', `Concurrent asset write failed integrity validation: ${staged.assetId}`, 409)
          }
        }
      }
      if (options.interruptAt === 'before-commit') fail('PROJECT_PACKAGE_IMPORT_INTERRUPTED', 'Injected project import interruption', 503)
      this.projectStore.database.exec('COMMIT')
      projectTransaction = false
      projectCommitted = true
      this.workspaceStore.database.exec('COMMIT')
      workspaceTransaction = false
    } catch (error) {
      if (workspaceTransaction) {
        try { this.workspaceStore.database.exec('ROLLBACK') } catch {}
      }
      if (projectTransaction) {
        try { this.projectStore.database.exec('ROLLBACK') } catch {}
      }
      if (projectCommitted) await this.compensateProjectImport(plan, newAssets).catch(() => {})
      for (const staged of stagedFiles) await unlink(staged.temporaryPath).catch(() => {})
      for (const staged of finalFiles) await unlink(staged.finalPath).catch(() => {})
      throw error
    }
    return {
      legacy: false,
      preview: inspected.preview,
      catalog,
      project: plan.project,
      documents: plan.documents.map(({ valueSha256: _hash, ...document }) => document),
      idMap: plan.idMap,
    }
  }

  async compensateProjectImport(plan, missingAssets) {
    const database = this.projectStore.database
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('DELETE FROM library_project_refs WHERE project_id = ?').run(plan.project.id)
      for (const item of [...plan.library.items].reverse()) database.prepare('DELETE FROM library_items WHERE id = ?').run(item.id)
      for (const collection of plan.library.collections) database.prepare('DELETE FROM library_collections WHERE id = ?').run(collection.id)
      for (const balanced of plan.balancedProjects) database.prepare('DELETE FROM projects WHERE id = ?').run(balanced.documentId)
      for (const asset of missingAssets) {
        const referenced = database.prepare(`
          SELECT 1 AS found WHERE
            EXISTS(SELECT 1 FROM project_assets WHERE asset_id = ?)
            OR EXISTS(SELECT 1 FROM asset_versions WHERE asset_id = ?)
            OR EXISTS(SELECT 1 FROM library_versions WHERE asset_id = ?)
        `).get(asset.id, asset.id, asset.id)
        if (!referenced) database.prepare('DELETE FROM assets WHERE id = ?').run(asset.id)
      }
      database.exec('COMMIT')
    } catch (error) {
      try { database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  async importLegacy(bundle, inspected, options = {}) {
    const conflictPolicy = options.conflictPolicy || 'reject'
    if (!['reject', 'copy'].includes(conflictPolicy)) fail('INVALID_PROJECT_PACKAGE_CONFLICT_POLICY', 'Conflict policy must be reject or copy')
    const originalDocumentId = inspected.legacyPayload.project.document.id
    const catalogRecord = this.workspaceStore.getCatalog()
    const occupied = new Set(catalogRecord.catalog.projects.flatMap(({ documents }) => documents.map(({ id }) => id)))
    const documentConflict = occupied.has(originalDocumentId) || Boolean(this.projectStore.getProject(originalDocumentId))
    if (documentConflict && conflictPolicy === 'reject') fail('PROJECT_PACKAGE_ID_CONFLICT', `Legacy canvas id already exists: ${originalDocumentId}`, 409)
    const documentId = documentConflict ? uniqueId('document-balanced', occupied) : originalDocumentId
    const projectIds = new Set(catalogRecord.catalog.projects.map(({ id }) => id))
    const requestedProjectId = options.projectId === undefined
      ? `project-${documentId}`.slice(0, 160)
      : assertId(options.projectId, 'projectId')
    const projectConflict = projectIds.has(requestedProjectId)
    if (projectConflict && conflictPolicy === 'reject') fail('PROJECT_PACKAGE_ID_CONFLICT', `Project id already exists: ${requestedProjectId}`, 409)
    const projectId = projectConflict ? uniqueId('project-import', projectIds) : requestedProjectId
    const now = assertInteger(options.now ?? Date.now(), 'now')
    const imported = await this.projectStore.importProjectBundle(bundle, { projectId: documentId })
    const project = {
      id: projectId,
      title: safeTitle(imported.title, '（旧画布导入）'),
      description: '由旧 `.miaohui` 单画布兼容包导入；原包不含像素、智能视频、恢复点与项目资源关系。',
      color: 'amber',
      initialModeId: 'balanced',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      trashedAt: null,
      documents: [{ id: documentId, modeId: 'balanced', title: imported.title, revision: imported.revision, createdAt: now, updatedAt: now }],
    }
    const catalog = assertProjectCatalog({ ...catalogRecord.catalog, revision: catalogRecord.catalog.revision + 1, projects: [...catalogRecord.catalog.projects, project] })
    const documentValue = validateWorkspaceModeDocument('balanced', JSON.stringify(imported.document), documentId)
    let workspaceTransaction = false
    try {
      this.workspaceStore.database.exec('BEGIN IMMEDIATE')
      workspaceTransaction = true
      const current = this.workspaceStore.getCatalog()
      if (current.catalog.revision !== catalogRecord.catalog.revision) {
        fail('WORKSPACE_CATALOG_CONFLICT', 'Workspace catalog changed while the legacy package was being prepared', 409)
      }
      this.workspaceStore.database.prepare(`
        UPDATE workspace_meta SET value_json = ?, updated_at = ? WHERE key = 'project-catalog'
      `).run(JSON.stringify(catalog), now)
      if (options.interruptAt === 'after-legacy-catalog') {
        fail('PROJECT_PACKAGE_IMPORT_INTERRUPTED', 'Injected legacy project import interruption', 503)
      }
      this.workspaceStore.database.prepare(`
        INSERT INTO mode_documents
          (document_id, project_id, mode_id, revision, value_json, created_at, updated_at)
        VALUES (?, ?, 'balanced', ?, ?, ?, ?)
      `).run(documentId, projectId, imported.revision, documentValue, now, now)
      this.workspaceStore.database.exec('COMMIT')
      workspaceTransaction = false
    } catch (error) {
      if (workspaceTransaction) {
        try { this.workspaceStore.database.exec('ROLLBACK') } catch {}
      }
      await this.projectStore.deleteProject(documentId).catch(() => {})
      await this.projectStore.collectGarbage().catch(() => {})
      throw error
    }
    return {
      legacy: true,
      preview: inspected.preview,
      catalog,
      project,
      documents: [this.workspaceStore.getModeDocument(documentId)],
      idMap: { projectId: { [inspected.preview.project.id]: projectId }, documentIds: { [originalDocumentId]: documentId }, libraryItemIds: {}, collectionIds: {} },
    }
  }

  async importBundle(bundle, options = {}) {
    this.assertOpen()
    const inspected = await this.inspectBundle(bundle)
    if (inspected.kind === 'legacy') return this.importLegacy(bundle, inspected, options)
    return this.importComplete(inspected, { ...options, bundleBytes: bundle.length })
  }
}
