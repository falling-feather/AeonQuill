const drafts = new Map()
const projectQueues = new Map()
const pendingSaves = new Map()

function projectIdOf(document) {
  return document && typeof document.id === 'string' ? document.id : ''
}

export function rememberCanvasDraft(document) {
  const projectId = projectIdOf(document)
  if (!projectId) throw new TypeError('canvas draft requires a document id')
  drafts.set(projectId, document)
}

export function getCanvasDraft(projectId) {
  return drafts.get(projectId) ?? null
}

export function markCanvasDraftPersisted(document) {
  const projectId = projectIdOf(document)
  if (projectId && drafts.get(projectId) === document) drafts.delete(projectId)
}

export function discardCanvasDraft(projectId) {
  drafts.delete(projectId)
}

export function discardCanvasDraftIfCurrent(projectId, expectedDocument) {
  if (!expectedDocument || drafts.get(projectId) !== expectedDocument) return false
  drafts.delete(projectId)
  return true
}

export function enqueueCanvasProjectMutation(projectId, mutation) {
  if (typeof projectId !== 'string' || !projectId) {
    return Promise.reject(new TypeError('canvas project mutation requires a project id'))
  }
  if (typeof mutation !== 'function') {
    return Promise.reject(new TypeError('canvas project mutation requires a function'))
  }
  const previous = projectQueues.get(projectId)
  const request = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => mutation())
  projectQueues.set(projectId, request)
  void request.finally(() => {
    if (projectQueues.get(projectId) === request) projectQueues.delete(projectId)
  }).catch(() => undefined)
  return request
}

export async function flushCanvasProjectMutation(projectId) {
  const pending = projectQueues.get(projectId)
  if (pending) await pending
}

export function queueCanvasDocumentSave(document, saveFn) {
  const projectId = projectIdOf(document)
  if (!projectId) return Promise.reject(new TypeError('canvas document save requires a document id'))
  if (typeof saveFn !== 'function') return Promise.reject(new TypeError('canvas document save requires a function'))
  rememberCanvasDraft(document)
  const existing = pendingSaves.get(projectId)
  if (existing?.document === document) return existing.promise

  const request = enqueueCanvasProjectMutation(projectId, async () => {
    const result = await saveFn(document)
    markCanvasDraftPersisted(document)
    return result
  })
  pendingSaves.set(projectId, { document, promise: request })
  void request.finally(() => {
    if (pendingSaves.get(projectId)?.promise === request) pendingSaves.delete(projectId)
  }).catch(() => undefined)
  return request
}
