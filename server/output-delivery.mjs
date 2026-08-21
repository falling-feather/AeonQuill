import { copyFile, stat } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'

export function resolveOutputDeliveryTarget(outputDirectory, filename) {
  const root = resolve(String(outputDirectory || ''))
  const safeFilename = basename(String(filename || ''))
  if (!safeFilename || safeFilename !== filename) {
    throw Object.assign(new Error('Output delivery filename must be a plain file name'), {
      code: 'INVALID_OUTPUT_DELIVERY_FILENAME',
    })
  }
  const targetPath = resolve(root, safeFilename)
  if (!targetPath.startsWith(`${root}${sep}`)) {
    throw Object.assign(new Error('Output delivery target is outside the configured directory'), {
      code: 'OUTPUT_DELIVERY_OUTSIDE_ROOT',
    })
  }
  return targetPath
}

export async function copyOutputDelivery({ sourcePath, outputDirectory, filename }) {
  const source = resolve(String(sourcePath || ''))
  const sourceInfo = await stat(source)
  if (!sourceInfo.isFile() || sourceInfo.size <= 0) {
    throw Object.assign(new Error('Managed output is missing or empty'), {
      code: 'OUTPUT_DELIVERY_SOURCE_INVALID',
    })
  }
  const targetPath = resolveOutputDeliveryTarget(outputDirectory, filename)
  await copyFile(source, targetPath)
  const targetInfo = await stat(targetPath)
  if (!targetInfo.isFile() || targetInfo.size !== sourceInfo.size) {
    throw Object.assign(new Error('Output delivery copy did not preserve the source size'), {
      code: 'OUTPUT_DELIVERY_COPY_INVALID',
    })
  }
  return { targetPath, bytes: targetInfo.size, filename }
}
