import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const PORTABLE_LAYOUT_FILENAME = 'aeonquill-layout.json'
export const PORTABLE_LAYOUT = 'sibling-user-data'
export const PORTABLE_DATA_DIRECTORY_NAME = 'UserData'

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly ${wanted.join(', ')}`)
  }
}

export function parsePortableLayout(source) {
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('AEONQUILL portable layout is not valid JSON')
  }
  assertExactKeys(
    value,
    ['schemaVersion', 'layout', 'dataDirectoryName'],
    'AEONQUILL portable layout',
  )
  if (value.schemaVersion !== 1) throw new Error('Unsupported AEONQUILL portable layout schema')
  if (value.layout !== PORTABLE_LAYOUT) throw new Error('Unsupported AEONQUILL portable layout kind')
  if (value.dataDirectoryName !== PORTABLE_DATA_DIRECTORY_NAME) {
    throw new Error('AEONQUILL portable data directory must be UserData')
  }
  return Object.freeze({
    schemaVersion: 1,
    layout: PORTABLE_LAYOUT,
    dataDirectoryName: PORTABLE_DATA_DIRECTORY_NAME,
  })
}

export function resolvePortableDataDirectory({
  executableDirectory,
  pathExists = existsSync,
  readText = (pathname) => readFileSync(pathname, 'utf8'),
}) {
  const applicationDirectory = resolve(executableDirectory)
  const markerPath = join(applicationDirectory, PORTABLE_LAYOUT_FILENAME)
  if (!pathExists(markerPath)) return null
  const layout = parsePortableLayout(readText(markerPath))
  const installationRoot = dirname(applicationDirectory)
  return Object.freeze({
    directory: join(installationRoot, layout.dataDirectoryName),
    layout: 'portable-sibling-user-data',
    markerPath,
  })
}
