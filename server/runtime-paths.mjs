import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export function resolveRuntimeDirectory() {
  return resolve(
    process.env.AEONQUILL_RUNTIME_DIR
      || process.env.MIAOHUI_RUNTIME_DIR
      || join(projectRoot, '.runtime'),
  )
}

export const runtimeDirectory = resolveRuntimeDirectory()

const DURABLE_DATA_MARKERS = ['jobs.json', 'projects', 'assets', 'client-state']

export function resolveDataDirectory({
  configuredDirectory = process.env.AEONQUILL_DATA_DIR || process.env.MIAOHUI_DATA_DIR,
  runtimeRoot = runtimeDirectory,
  pathExists = existsSync,
} = {}) {
  if (!configuredDirectory) return resolve(runtimeRoot)
  const target = resolve(configuredDirectory)
  const legacy = resolve(runtimeRoot)
  if (target === legacy) return target
  const targetHasDurableData = DURABLE_DATA_MARKERS.some((entry) => pathExists(join(target, entry)))
  const legacyHasDurableData = DURABLE_DATA_MARKERS.some((entry) => pathExists(join(legacy, entry)))
  return legacyHasDurableData && !targetHasDurableData ? legacy : target
}

export function resolveCacheDirectory() {
  return resolve(
    process.env.AEONQUILL_CACHE_DIR
      || process.env.MIAOHUI_CACHE_DIR
      || join(runtimeDirectory, 'cache'),
  )
}

export function resolveLogDirectory() {
  return resolve(
    process.env.AEONQUILL_LOG_DIR
      || process.env.MIAOHUI_LOG_DIR
      || join(runtimeDirectory, 'logs'),
  )
}

export const dataDirectory = resolveDataDirectory()
export const usingLegacyDataDirectory = Boolean(
  (process.env.AEONQUILL_DATA_DIR || process.env.MIAOHUI_DATA_DIR)
  && resolve(process.env.AEONQUILL_DATA_DIR || process.env.MIAOHUI_DATA_DIR) !== dataDirectory,
)
export const cacheDirectory = resolveCacheDirectory()
export const logDirectory = resolveLogDirectory()
