import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const DURABLE_USER_DATA_MARKERS = Object.freeze([
  join('data', 'jobs.json'),
  join('data', 'projects'),
  join('data', 'assets'),
  join('data', 'client-state'),
  join('runtime', 'jobs.json'),
  join('runtime', 'projects'),
  join('runtime', 'assets'),
  join('runtime', 'client-state'),
])

function containsDurableData(rootDirectory, pathExists) {
  return DURABLE_USER_DATA_MARKERS.some((marker) => pathExists(join(rootDirectory, marker)))
}

export function selectElectronUserDataDirectory({
  defaultDirectory,
  legacyDirectory,
  explicitDirectory,
  storagePathsExplicit = false,
  pathExists = existsSync,
}) {
  const current = resolve(defaultDirectory)
  if (explicitDirectory) {
    return Object.freeze({ directory: resolve(explicitDirectory), layout: 'explicit' })
  }
  if (storagePathsExplicit) {
    return Object.freeze({ directory: current, layout: 'aeonquill-explicit-storage' })
  }

  const legacy = resolve(legacyDirectory)
  const currentHasDurableData = containsDurableData(current, pathExists)
  const legacyHasDurableData = containsDurableData(legacy, pathExists)
  if (!currentHasDurableData && legacyHasDurableData) {
    return Object.freeze({ directory: legacy, layout: 'legacy-miaohui-preserved' })
  }
  return Object.freeze({ directory: current, layout: 'aeonquill' })
}
