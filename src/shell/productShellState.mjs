const PRODUCT_MODE_IDS = new Set(['balanced', 'pixel', 'smart-video'])
const VIDEO_SOURCE_KINDS = new Set(['idea', 'script'])

export const PRODUCT_SHELL_PREFERENCES_KEY = 'aeonquill:product-shell:v1'
export const SMART_VIDEO_SESSION_KEY = 'aeonquill:smart-video-session:v1'
export const DEFAULT_BALANCED_PROJECT_ID = 'local-project'

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isProductModeId(value) {
  return typeof value === 'string' && PRODUCT_MODE_IDS.has(value)
}

export function normalizeProjectReference(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > 180 || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined
  return normalized
}

export function parseProductHash(hash) {
  const rawHash = typeof hash === 'string' ? hash : ''
  if (!rawHash || rawHash === '#' || rawHash === '#/' || rawHash === '#/home') {
    return { modeId: 'home', canonical: rawHash !== '#/home' }
  }

  const routeText = rawHash.replace(/^#\/?/u, '')
  const queryIndex = routeText.indexOf('?')
  const path = queryIndex === -1 ? routeText : routeText.slice(0, queryIndex)
  const query = queryIndex === -1 ? '' : routeText.slice(queryIndex + 1)
  const segments = path.split('/').filter(Boolean)

  if (segments.length !== 1 || !isProductModeId(segments[0])) {
    return { modeId: 'home', canonical: false }
  }

  const params = new URLSearchParams(query)
  const rawProjectId = params.get('project')
  const projectId = normalizeProjectReference(rawProjectId)
  if (rawProjectId !== null && !projectId) return { modeId: 'home', canonical: false }

  return projectId
    ? { modeId: segments[0], projectId, canonical: true }
    : { modeId: segments[0], canonical: true }
}

export function createProductTarget(pathname, search, location) {
  const basePath = typeof pathname === 'string' && pathname ? pathname : '/'
  const baseSearch = typeof search === 'string' ? search : ''
  if (!location || location.modeId === 'home') return `${basePath}${baseSearch}`
  if (!isProductModeId(location.modeId)) return `${basePath}${baseSearch}`

  const params = new URLSearchParams()
  const projectId = normalizeProjectReference(location.projectId)
  if (projectId) params.set('project', projectId)
  const query = params.size ? `?${params.toString()}` : ''
  return `${basePath}${baseSearch}#/${location.modeId}${query}`
}

export function parseShellPreferences(rawValue) {
  const fallback = {
    version: 1,
    selectedModeId: 'balanced',
    balancedProjectId: DEFAULT_BALANCED_PROJECT_ID,
  }

  if (typeof rawValue !== 'string' || !rawValue) return fallback
  try {
    const value = JSON.parse(rawValue)
    if (!isRecord(value) || value.version !== 1 || !isProductModeId(value.selectedModeId)) return fallback
    return {
      version: 1,
      selectedModeId: value.selectedModeId,
      balancedProjectId: normalizeProjectReference(value.balancedProjectId) ?? DEFAULT_BALANCED_PROJECT_ID,
    }
  } catch {
    return fallback
  }
}

export function serializeShellPreferences(preferences) {
  const normalized = parseShellPreferences(JSON.stringify({
    version: 1,
    selectedModeId: preferences?.selectedModeId,
    balancedProjectId: preferences?.balancedProjectId,
  }))
  return JSON.stringify(normalized)
}

export function parseSmartVideoSession(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue) return null
  try {
    const value = JSON.parse(rawValue)
    if (!isRecord(value) || value.version !== 1) return null
    const projectId = normalizeProjectReference(value.projectId)
    const title = typeof value.title === 'string' ? value.title.trim().slice(0, 120) : ''
    const sourceText = typeof value.sourceText === 'string' ? value.sourceText : ''
    if (
      !projectId ||
      !title ||
      !VIDEO_SOURCE_KINDS.has(value.sourceKind) ||
      !sourceText.trim() ||
      sourceText.length > 60_000 ||
      !Number.isInteger(value.updatedAt) ||
      value.updatedAt <= 0 ||
      !Number.isInteger(value.sceneCount) ||
      value.sceneCount < 0 ||
      !Number.isInteger(value.taskCount) ||
      value.taskCount < 0
    ) return null

    return {
      version: 1,
      projectId,
      title,
      sourceKind: value.sourceKind,
      sourceText,
      updatedAt: value.updatedAt,
      sceneCount: value.sceneCount,
      taskCount: value.taskCount,
    }
  } catch {
    return null
  }
}

export function serializeSmartVideoSession(session) {
  const normalized = parseSmartVideoSession(JSON.stringify({
    version: 1,
    projectId: session?.projectId,
    title: session?.title,
    sourceKind: session?.sourceKind,
    sourceText: session?.sourceText,
    updatedAt: session?.updatedAt,
    sceneCount: session?.sceneCount,
    taskCount: session?.taskCount,
  }))
  if (!normalized) throw new TypeError('Invalid AEONQUILL smart-video session summary')
  return JSON.stringify(normalized)
}

export function resolveCollectionState({ loading, error, itemCount, recoveredCount }) {
  if (loading && itemCount === 0) return 'loading'
  if (error) return 'error'
  if (itemCount === 0) return 'empty'
  if (recoveredCount > 0) return 'recovered'
  return 'ready'
}

export function resolvePixelDraftEntry({ requestedProjectId, status, documentId }) {
  const requested = normalizeProjectReference(requestedProjectId)
  const currentDocumentId = normalizeProjectReference(documentId)
  const hasMemoryDocument = Boolean(currentDocumentId)
  return {
    hasMemoryDocument,
    requestedDraftMissing: Boolean(requested && requested !== currentDocumentId),
    unreadable: status === 'error' && !hasMemoryDocument,
  }
}
