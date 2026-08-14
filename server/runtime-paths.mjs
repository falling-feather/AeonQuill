import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export function resolveRuntimeDirectory() {
  return resolve(process.env.MIAOHUI_RUNTIME_DIR || join(projectRoot, '.runtime'))
}

export const runtimeDirectory = resolveRuntimeDirectory()
