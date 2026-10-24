import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, lstat, rename, rm, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDirectory = fileURLToPath(new URL('../desktop/runtime/h3-native-memory/', import.meta.url))
const filenames = ['__init__.py', 'minimax_nodes.py', 'LICENSE', 'source-lock.json']
const fail = (code, message) => Object.assign(new Error(message), { code })
const sha256 = data => createHash('sha256').update(data).digest('hex')

export async function stageH3NativeMemoryAddon(destination) {
  if (typeof destination !== 'string' || !isAbsolute(destination) || basename(destination) !== 'aeonquill_h3_memory' || basename(dirname(destination)) !== 'custom_nodes') {
    throw fail('H3_MEMORY_DESTINATION_INVALID', 'Use an absolute custom_nodes/aeonquill_h3_memory destination')
  }
  const parent = await realpath(dirname(destination))
  const target = join(parent, 'aeonquill_h3_memory')
  const files = new Map(await Promise.all(filenames.map(async name => [name, await readFile(join(packageDirectory, name))])))
  const lock = JSON.parse(files.get('source-lock.json').toString('utf8'))
  if (sha256(files.get('minimax_nodes.py')) !== lock.sourceSha256 || sha256(files.get('LICENSE')) !== lock.licenseSha256) {
    throw fail('H3_MEMORY_SOURCE_CHANGED', 'Pinned H3 memory source or license failed its SHA-256 check')
  }
  let existing
  try { existing = await lstat(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw fail('H3_MEMORY_DESTINATION_MODIFIED', 'Destination is not a plain node-package directory')
    for (const [name, expected] of files) {
      let actual
      try { actual = await readFile(join(target, name)) } catch { throw fail('H3_MEMORY_DESTINATION_MODIFIED', `Existing package is incomplete: ${name}`) }
      if (!actual.equals(expected)) throw fail('H3_MEMORY_DESTINATION_MODIFIED', `Existing package was modified: ${name}`)
    }
    return { created: false, destination: target, sourceCommit: lock.sourceCommit }
  }
  const staging = await mkdtemp(join(parent, '.aeonquill-h3-memory-stage-'))
  let published = false
  try {
    for (const [name, contents] of files) await writeFile(join(staging, name), contents, { flag: 'wx' })
    await rename(staging, target)
    published = true
  } finally {
    if (!published) {
      const actual = await realpath(staging)
      if (!actual.startsWith(parent + sep) || !basename(actual).startsWith('.aeonquill-h3-memory-stage-')) throw new Error('Unexpected staging cleanup path')
      await rm(actual, { recursive: true })
    }
  }
  return { created: true, destination: target, sourceCommit: lock.sourceCommit }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const argument = process.argv.find(value => value.startsWith('--destination='))
  if (!argument) throw new Error('Usage: node scripts/stage-h3-memory-addon.mjs --destination=<absolute custom_nodes/aeonquill_h3_memory>')
  console.log(JSON.stringify(await stageH3NativeMemoryAddon(argument.slice('--destination='.length))))
}
