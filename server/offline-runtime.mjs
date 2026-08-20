import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { runtimeDirectory } from './runtime-paths.mjs'

export const OFFLINE_RUNTIME_PACKAGE_ID = 'aeonquill-comfyui-h3-cu129-win-x64-v1'

const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,79}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

async function isFile(pathname) {
  try {
    return (await stat(pathname)).isFile()
  } catch {
    return false
  }
}

function resolveInside(root, relativePath) {
  const target = resolve(root, relativePath)
  const relation = relative(resolve(root), target)
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error(`Offline runtime path escaped its package: ${relativePath}`)
  }
  return target
}

export function offlineRuntimeLayout(packageRoot) {
  return {
    packageRoot,
    manifestPath: join(packageRoot, 'runtime-manifest.json'),
    comfyRoot: join(packageRoot, 'ComfyUI'),
    pythonPath: join(packageRoot, 'python', 'python.exe'),
    ffmpegPath: join(packageRoot, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    ffprobePath: join(packageRoot, 'tools', 'ffmpeg', 'bin', 'ffprobe.exe'),
    rembgModelsPath: join(packageRoot, 'models', 'rembg'),
    realEsrganPath: join(packageRoot, 'tools', 'realesrgan-ncnn-vulkan', 'realesrgan-ncnn-vulkan.exe'),
    realEsrganModelsPath: join(packageRoot, 'tools', 'realesrgan-ncnn-vulkan', 'models'),
  }
}

export function defaultOfflineRuntimeRoot(baseRuntimeDirectory = runtimeDirectory) {
  return join(baseRuntimeDirectory, 'packages', OFFLINE_RUNTIME_PACKAGE_ID)
}

export async function sha256File(pathname) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) hash.update(chunk)
  return hash.digest('hex')
}

export async function probeOfflineRuntimePackage({
  baseRuntimeDirectory = runtimeDirectory,
  packageRoot,
  verifyCriticalHashes = false,
} = {}) {
  const layout = offlineRuntimeLayout(packageRoot || defaultOfflineRuntimeRoot(baseRuntimeDirectory))
  if (!(await isFile(layout.manifestPath))) return null
  let manifest
  try {
    manifest = JSON.parse(await readFile(layout.manifestPath, 'utf8'))
  } catch {
    return null
  }
  if (
    manifest?.schemaVersion !== 1
    || manifest.packageId !== OFFLINE_RUNTIME_PACKAGE_ID
    || !PACKAGE_ID_PATTERN.test(manifest.packageId)
    || !Array.isArray(manifest.criticalFiles)
    || manifest.criticalFiles.length < 1
    || manifest.criticalFiles.length > 500
  ) return null
  const requiredEntrypoints = [
    layout.pythonPath,
    join(layout.comfyRoot, 'main.py'),
    layout.ffmpegPath,
    layout.ffprobePath,
  ]
  if (!(await Promise.all(requiredEntrypoints.map(isFile))).every(Boolean)) return null
  const seenCriticalPaths = new Set()
  try {
    for (const entry of manifest.criticalFiles) {
      if (
        !entry
        || typeof entry.path !== 'string'
        || seenCriticalPaths.has(entry.path)
        || !Number.isSafeInteger(entry.bytes)
        || entry.bytes < 1
        || !SHA256_PATTERN.test(entry.sha256)
      ) return null
      seenCriticalPaths.add(entry.path)
      const pathname = resolveInside(layout.packageRoot, entry.path)
      const fileStats = await stat(pathname)
      if (!fileStats.isFile() || fileStats.size !== entry.bytes) return null
      if (verifyCriticalHashes && await sha256File(pathname) !== entry.sha256) return null
    }
  } catch {
    return null
  }
  return {
    ...layout,
    packageId: manifest.packageId,
    productVersion: manifest.productVersion,
    manifest,
  }
}
