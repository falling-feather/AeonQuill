import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, lstat, rename, rm, realpath, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDirectory = fileURLToPath(new URL('../desktop/runtime/h3-native-memory/', import.meta.url))
const filenames = ['attention_reuse.py', 'minimax_nodes.py', 'LICENSE', 'source-lock.json', '__init__.py']
const knownV1 = Object.freeze({
  '__init__.py': '06fc0a0041d10c3c3dc9bf211897737ec61c952bde945c9695cba083f227e94b',
  'source-lock.json': 'abf07a5fc41b45ad5fcf4162846f63d1ef2a3f4750d8916d748d8babd3c191b6',
})
const fail = (code, message) => Object.assign(new Error(message), { code })
const sha256 = data => createHash('sha256').update(data).digest('hex')

export async function stageH3NativeMemoryAddon(destination, { upgradeKnown = false } = {}) {
  if (typeof upgradeKnown !== 'boolean') throw new TypeError('upgradeKnown must be a boolean')
  if (typeof destination !== 'string' || !isAbsolute(destination) || basename(destination) !== 'aeonquill_h3_memory' || basename(dirname(destination)) !== 'custom_nodes') {
    throw fail('H3_MEMORY_DESTINATION_INVALID', 'Use an absolute custom_nodes/aeonquill_h3_memory destination')
  }
  const parent = await realpath(dirname(destination))
  const target = join(parent, 'aeonquill_h3_memory')
  const files = new Map(await Promise.all(filenames.map(async name => [name, await readFile(join(packageDirectory, name))])))
  const lock = JSON.parse(files.get('source-lock.json').toString('utf8'))
  if (sha256(files.get('minimax_nodes.py')) !== lock.sourceSha256 || sha256(files.get('LICENSE')) !== lock.licenseSha256 || sha256(files.get('attention_reuse.py')) !== lock.adapter.sha256) {
    throw fail('H3_MEMORY_SOURCE_CHANGED', 'Pinned H3 memory source or license failed its SHA-256 check')
  }
  let existing
  try { existing = await lstat(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const previous = new Map()
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw fail('H3_MEMORY_DESTINATION_MODIFIED', 'Destination is not a plain node-package directory')
    for (const [name, expected] of files) {
      try {
        const entry = await lstat(join(target, name))
        if (!entry.isFile() || entry.isSymbolicLink()) throw fail('H3_MEMORY_DESTINATION_MODIFIED', `Package member is not a plain file: ${name}`)
        previous.set(name, await readFile(join(target, name)))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        previous.set(name, null)
      }
    }
    if ([...files].every(([name, expected]) => previous.get(name)?.equals(expected))) {
      return { created: false, destination: target, sourceCommit: lock.sourceCommit, addonRevision: lock.addonRevision }
    }
    const v1Hashes = { ...knownV1, 'minimax_nodes.py': lock.sourceSha256, LICENSE: lock.licenseSha256 }
    const recognized = previous.get('attention_reuse.py') === null && Object.entries(v1Hashes).every(([name, hash]) => previous.get(name) && sha256(previous.get(name)) === hash)
    const unknown = (await readdir(target)).filter(name => !filenames.includes(name) && name !== '__pycache__')
    if (!upgradeKnown || !recognized || unknown.length) {
      throw fail('H3_MEMORY_DESTINATION_MODIFIED', 'Existing package differs; only an exact known v1 package may be explicitly upgraded')
    }
  }
  const staging = await mkdtemp(join(parent, '.aeonquill-h3-memory-stage-'))
  let published = false
  const changed = []
  try {
    for (const [name, contents] of files) await writeFile(join(staging, name), contents, { flag: 'wx' })
    if (!existing) {
      await rename(staging, target)
      published = true
    } else {
      try {
        for (const [name, contents] of files) {
          if (previous.get(name)?.equals(contents)) continue
          await rename(join(staging, name), join(target, name))
          changed.push(name)
        }
      } catch (error) {
        const rollbackErrors = []
        for (const name of changed.reverse()) {
          try {
            const old = previous.get(name)
            if (old === null) await unlink(join(target, name))
            else {
              const rollback = join(staging, name + '.rollback')
              await writeFile(rollback, old, { flag: 'wx' })
              await rename(rollback, join(target, name))
            }
          } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        }
        if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'H3 package upgrade and rollback failed')
        throw error
      }
    }
  } finally {
    if (!published) {
      const actual = await realpath(staging)
      if (!actual.startsWith(parent + sep) || !basename(actual).startsWith('.aeonquill-h3-memory-stage-')) throw new Error('Unexpected staging cleanup path')
      await rm(actual, { recursive: true })
    }
  }
  return { created: !existing, upgraded: Boolean(existing), destination: target, sourceCommit: lock.sourceCommit, addonRevision: lock.addonRevision }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const argument = process.argv.find(value => value.startsWith('--destination='))
  if (!argument) throw new Error('Usage: node scripts/stage-h3-memory-addon.mjs --destination=<absolute custom_nodes/aeonquill_h3_memory>')
  console.log(JSON.stringify(await stageH3NativeMemoryAddon(argument.slice('--destination='.length), { upgradeKnown: process.argv.includes('--upgrade-known') })))
}
