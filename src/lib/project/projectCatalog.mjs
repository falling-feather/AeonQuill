export const PROJECT_CATALOG_SCHEMA_VERSION = 1
export const PROJECT_TRASH_RETENTION_DAYS = 15

export const PROJECT_MODE_IDS = Object.freeze(['balanced', 'pixel', 'smart-video'])
export const PROJECT_STATUS_IDS = Object.freeze(['active', 'archived', 'trashed'])
export const PROJECT_COLOR_IDS = Object.freeze(['ink', 'amber', 'sage', 'blue', 'violet', 'rose'])

const MODE_IDS = new Set(PROJECT_MODE_IDS)
const STATUS_IDS = new Set(PROJECT_STATUS_IDS)
const COLOR_IDS = new Set(PROJECT_COLOR_IDS)
const PROJECT_KEYS = new Set([
  'id', 'title', 'description', 'color', 'initialModeId', 'status', 'createdAt', 'updatedAt',
  'lastOpenedAt', 'trashedAt', 'documents',
])
const DOCUMENT_KEYS = new Set([
  'id', 'modeId', 'title', 'revision', 'createdAt', 'updatedAt',
])
const CATALOG_KEYS = new Set(['schemaVersion', 'revision', 'projects'])
const COMMAND_KEYS = new Set(['id', 'type', 'baseRevision', 'payload'])
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u

export class ProjectCatalogError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'ProjectCatalogError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new ProjectCatalogError(code, message, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return globalThis.structuredClone(value)
}

function assertExactKeys(value, allowed, path) {
  if (!isRecord(value)) fail('INVALID_OBJECT', `${path} must be an object`)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) fail('UNKNOWN_FIELD', `${path} contains unsupported fields`, { path, fields: unknown })
  const missing = [...allowed].filter((key) => !(key in value))
  if (missing.length) fail('MISSING_FIELD', `${path} is missing required fields`, { path, fields: missing })
}

function assertInteger(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('INVALID_INTEGER', `${path} must be an integer >= ${minimum}`)
}

function assertId(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('INVALID_ID', `${path} is invalid`)
}

function assertText(value, path, maxLength, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail('INVALID_TEXT', `${path} must be a string`)
  if (!allowEmpty && !value.trim()) fail('EMPTY_TEXT', `${path} cannot be empty`)
  if (value.length > maxLength) fail('TEXT_TOO_LONG', `${path} exceeds ${maxLength} characters`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail('CONTROL_CHARACTER', `${path} contains unsupported control characters`)
  }
}

function normalizeText(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback
  return value.trim().replace(/\s+/gu, ' ').slice(0, maxLength)
}

function assertModeId(value, path) {
  if (!MODE_IDS.has(value)) fail('INVALID_MODE', `${path} is unsupported`)
}

function assertDocument(document, path) {
  assertExactKeys(document, DOCUMENT_KEYS, path)
  assertId(document.id, `${path}.id`)
  assertModeId(document.modeId, `${path}.modeId`)
  assertText(document.title, `${path}.title`, 120)
  assertInteger(document.revision, `${path}.revision`)
  assertInteger(document.createdAt, `${path}.createdAt`)
  assertInteger(document.updatedAt, `${path}.updatedAt`)
  if (document.updatedAt < document.createdAt) fail('INVALID_TIME_ORDER', `${path}.updatedAt cannot precede createdAt`)
  return document
}

function assertProject(project, path) {
  assertExactKeys(project, PROJECT_KEYS, path)
  assertId(project.id, `${path}.id`)
  assertText(project.title, `${path}.title`, 120)
  assertText(project.description, `${path}.description`, 600, { allowEmpty: true })
  if (!COLOR_IDS.has(project.color)) fail('INVALID_COLOR', `${path}.color is unsupported`)
  assertModeId(project.initialModeId, `${path}.initialModeId`)
  if (!STATUS_IDS.has(project.status)) fail('INVALID_STATUS', `${path}.status is unsupported`)
  assertInteger(project.createdAt, `${path}.createdAt`)
  assertInteger(project.updatedAt, `${path}.updatedAt`)
  assertInteger(project.lastOpenedAt, `${path}.lastOpenedAt`)
  if (project.updatedAt < project.createdAt || project.lastOpenedAt < project.createdAt) {
    fail('INVALID_TIME_ORDER', `${path} timestamps are out of order`)
  }
  if (project.status === 'trashed') {
    assertInteger(project.trashedAt, `${path}.trashedAt`)
  } else if (project.trashedAt !== null) {
    fail('INVALID_TRASH_TIME', `${path}.trashedAt must be null outside trash`)
  }
  if (!Array.isArray(project.documents) || project.documents.length === 0) {
    fail('EMPTY_DOCUMENTS', `${path}.documents must contain at least one mode document`)
  }
  const ids = new Set()
  project.documents.forEach((document, index) => {
    assertDocument(document, `${path}.documents[${index}]`)
    if (ids.has(document.id)) fail('DUPLICATE_DOCUMENT', `${path} contains duplicate document ids`)
    ids.add(document.id)
  })
  if (!project.documents.some((document) => document.modeId === project.initialModeId)) {
    fail('MISSING_INITIAL_DOCUMENT', `${path} has no document for its initial mode`)
  }
  return project
}

export function assertProjectCatalog(input) {
  assertExactKeys(input, CATALOG_KEYS, 'catalog')
  if (input.schemaVersion !== PROJECT_CATALOG_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA', `Unsupported project catalog schema: ${input.schemaVersion}`)
  }
  assertInteger(input.revision, 'catalog.revision')
  if (!Array.isArray(input.projects)) fail('INVALID_PROJECTS', 'catalog.projects must be an array')
  const projectIds = new Set()
  const documentIds = new Set()
  input.projects.forEach((project, index) => {
    assertProject(project, `catalog.projects[${index}]`)
    if (projectIds.has(project.id)) fail('DUPLICATE_PROJECT', 'catalog contains duplicate project ids')
    projectIds.add(project.id)
    for (const document of project.documents) {
      if (documentIds.has(document.id)) fail('DUPLICATE_DOCUMENT', 'catalog contains a document used by multiple projects')
      documentIds.add(document.id)
    }
  })
  return clone(input)
}

export function createProjectCatalog() {
  return assertProjectCatalog({
    schemaVersion: PROJECT_CATALOG_SCHEMA_VERSION,
    revision: 0,
    projects: [],
  })
}

function generatedId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${suffix}`.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 160)
}

function nextCatalog(catalog, projects) {
  return assertProjectCatalog({ ...catalog, revision: catalog.revision + 1, projects })
}

function projectIndex(catalog, projectId) {
  const index = catalog.projects.findIndex((project) => project.id === projectId)
  if (index < 0) fail('PROJECT_NOT_FOUND', `Project not found: ${projectId}`)
  return index
}

function replaceProject(catalog, index, project) {
  const projects = [...catalog.projects]
  projects[index] = project
  return nextCatalog(catalog, projects)
}

export function createWorkspaceProject(catalogInput, input, options = {}) {
  const catalog = assertProjectCatalog(catalogInput)
  if (!isRecord(input)) fail('INVALID_CREATE_INPUT', 'Project create input must be an object')
  const now = options.now ?? Date.now()
  assertInteger(now, 'create.now')
  const modeId = input.initialModeId ?? 'balanced'
  assertModeId(modeId, 'create.initialModeId')
  const title = normalizeText(input.title, 120)
  assertText(title, 'create.title', 120)
  const projectId = options.projectId ?? generatedId('project')
  const documentId = options.documentId ?? generatedId(`document-${modeId}`)
  assertId(projectId, 'create.projectId')
  assertId(documentId, 'create.documentId')
  if (catalog.projects.some((project) => project.id === projectId)) fail('PROJECT_EXISTS', `Project already exists: ${projectId}`)
  if (catalog.projects.some((project) => project.documents.some((document) => document.id === documentId))) {
    fail('DOCUMENT_EXISTS', `Document already exists: ${documentId}`)
  }
  const project = assertProject({
    id: projectId,
    title,
    description: normalizeText(input.description, 600),
    color: COLOR_IDS.has(input.color) ? input.color : 'amber',
    initialModeId: modeId,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    trashedAt: null,
    documents: [{
      id: documentId,
      modeId,
      title: normalizeText(input.documentTitle, 120, `${title} · ${modeId}`),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    }],
  }, 'project')
  return { catalog: nextCatalog(catalog, [...catalog.projects, project]), project: clone(project), document: clone(project.documents[0]) }
}

export function addProjectDocument(catalogInput, projectId, input, options = {}) {
  const catalog = assertProjectCatalog(catalogInput)
  const index = projectIndex(catalog, projectId)
  const current = catalog.projects[index]
  if (current.status === 'trashed') fail('PROJECT_TRASHED', 'Cannot add documents to a trashed project')
  const now = options.now ?? Date.now()
  const modeId = input?.modeId
  assertModeId(modeId, 'document.modeId')
  const documentId = options.documentId ?? generatedId(`document-${modeId}`)
  assertId(documentId, 'document.id')
  if (catalog.projects.some((project) => project.documents.some((document) => document.id === documentId))) {
    fail('DOCUMENT_EXISTS', `Document already exists: ${documentId}`)
  }
  const document = assertDocument({
    id: documentId,
    modeId,
    title: normalizeText(input.title, 120, `${current.title} · ${modeId}`),
    revision: 0,
    createdAt: now,
    updatedAt: now,
  }, 'document')
  const project = assertProject({
    ...current,
    status: 'active',
    updatedAt: now,
    lastOpenedAt: now,
    trashedAt: null,
    documents: [...current.documents, document],
  }, 'project')
  return { catalog: replaceProject(catalog, index, project), project: clone(project), document: clone(document) }
}

export function touchProjectDocument(catalogInput, projectId, documentId, input = {}, options = {}) {
  const catalog = assertProjectCatalog(catalogInput)
  const index = projectIndex(catalog, projectId)
  const current = catalog.projects[index]
  const documentIndex = current.documents.findIndex((document) => document.id === documentId)
  if (documentIndex < 0) fail('DOCUMENT_NOT_FOUND', `Document not found: ${documentId}`)
  const now = options.now ?? Date.now()
  const documents = [...current.documents]
  const previous = documents[documentIndex]
  documents[documentIndex] = assertDocument({
    ...previous,
    title: input.title === undefined ? previous.title : normalizeText(input.title, 120),
    revision: input.revision === undefined ? previous.revision : input.revision,
    updatedAt: now,
  }, 'document')
  const project = assertProject({
    ...current,
    title: input.projectTitle === undefined ? current.title : normalizeText(input.projectTitle, 120),
    status: 'active',
    updatedAt: now,
    lastOpenedAt: now,
    trashedAt: null,
    documents,
  }, 'project')
  return replaceProject(catalog, index, project)
}

export function setProjectStatus(catalogInput, projectId, status, options = {}) {
  const catalog = assertProjectCatalog(catalogInput)
  if (!STATUS_IDS.has(status)) fail('INVALID_STATUS', `Unsupported project status: ${status}`)
  const index = projectIndex(catalog, projectId)
  const now = options.now ?? Date.now()
  const current = catalog.projects[index]
  const project = assertProject({
    ...current,
    status,
    updatedAt: now,
    lastOpenedAt: status === 'active' ? now : current.lastOpenedAt,
    trashedAt: status === 'trashed' ? now : null,
  }, 'project')
  return replaceProject(catalog, index, project)
}

export function openWorkspaceProject(catalogInput, projectId, options = {}) {
  const catalog = assertProjectCatalog(catalogInput)
  const index = projectIndex(catalog, projectId)
  const current = catalog.projects[index]
  if (current.status === 'trashed') fail('PROJECT_TRASHED', 'Restore the project before opening it')
  const now = options.now ?? Date.now()
  return replaceProject(catalog, index, assertProject({
    ...current,
    status: 'active',
    updatedAt: Math.max(current.updatedAt, now),
    lastOpenedAt: now,
    trashedAt: null,
  }, 'project'))
}

export function purgeExpiredProjects(catalogInput, options = {}) {
  const catalog = assertProjectCatalog(catalogInput)
  const now = options.now ?? Date.now()
  const retentionDays = options.retentionDays ?? PROJECT_TRASH_RETENTION_DAYS
  assertInteger(retentionDays, 'purge.retentionDays', 1)
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  const projects = catalog.projects.filter((project) => project.status !== 'trashed' || project.trashedAt > cutoff)
  return projects.length === catalog.projects.length ? catalog : nextCatalog(catalog, projects)
}

export function projectModeDocument(projectInput, modeId) {
  const project = assertProject(projectInput, 'project')
  assertModeId(modeId, 'modeId')
  return clone(project.documents
    .filter((document) => document.modeId === modeId)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))[0] ?? null)
}

export function serializeProjectCatalog(catalog) {
  return JSON.stringify(assertProjectCatalog(catalog))
}

export function deserializeProjectCatalog(serialized) {
  if (typeof serialized !== 'string' || !serialized) return createProjectCatalog()
  try {
    return assertProjectCatalog(JSON.parse(serialized))
  } catch (error) {
    if (error instanceof ProjectCatalogError) throw error
    fail('INVALID_JSON', 'Project catalog is not valid JSON')
  }
}
