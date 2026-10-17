import { encodeWorkspaceRequestBody } from './workspaceRequestBody.mjs'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(value: unknown): void
}
scope.onmessage = (event) => {
  try {
    scope.postMessage({ ok: true, body: encodeWorkspaceRequestBody(event.data) })
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : '工作区保存编码失败' })
  }
}
export {}
