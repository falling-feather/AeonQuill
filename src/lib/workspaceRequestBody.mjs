const LARGE_REQUEST_CHARACTERS = 1024 * 1024

export function encodeWorkspaceRequestBody(input) {
  const json = JSON.stringify(input)
  return json.length >= LARGE_REQUEST_CHARACTERS
    ? new Blob([new TextEncoder().encode(json)], { type: 'application/json' })
    : json
}

function defaultWorkerFactory() {
  return new Worker(new URL('./workspaceRequestBody.worker.ts', import.meta.url), { type: 'module' })
}

export async function prepareWorkspaceRequestBody(input, options = {}) {
  // The large field is already a serialized mode document. Read its size without
  // building the second escaped JSON string on the UI thread.
  if (typeof input?.value !== 'string' || input.value.length < LARGE_REQUEST_CHARACTERS) {
    return encodeWorkspaceRequestBody(input)
  }
  let worker
  try {
    worker = (options.workerFactory ?? defaultWorkerFactory)()
    if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') {
      throw new Error('Workspace body Worker is unavailable')
    }
  } catch {
    try { worker?.terminate?.() } catch { /* failed Worker setup has no live request */ }
    return encodeWorkspaceRequestBody(input)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try { worker.terminate() } catch { /* result ownership has already ended */ }
      action()
    }
    const fallback = () => finish(() => {
      try { resolve(encodeWorkspaceRequestBody(input)) } catch (error) { reject(error) }
    })
    const timeout = setTimeout(() => finish(() => reject(new Error('工作区保存编码超时，草稿仍保留，请重试'))), 30_000)
    worker.onmessage = (event) => {
      const response = event.data
      if (response?.ok === false) {
        finish(() => reject(new Error(typeof response.error === 'string' ? response.error : '工作区保存编码失败')))
      } else if (response?.ok === true && (response.body instanceof Blob || typeof response.body === 'string')) {
        finish(() => resolve(response.body))
      } else {
        finish(() => reject(new Error('工作区保存编码响应无效')))
      }
    }
    worker.onerror = fallback
    try { worker.postMessage(input) } catch { fallback() }
  })
}
