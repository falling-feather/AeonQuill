import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, unlink } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { stageH3NativeMemoryAddon } from '../scripts/stage-h3-memory-addon.mjs'

async function temporary(t) {
  const parent = resolve('.runtime/qa-temp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'h3-memory-package-'))
  t.after(async () => {
    assert.ok((await realpath(directory)).startsWith(parent + sep))
    await rm(directory, { recursive: true })
  })
  await mkdir(join(directory, 'custom_nodes'))
  return directory
}

test('stages the pinned nodes and local adapter and permits identical reuse', async t => {
  const root = await temporary(t)
  const destination = join(root, 'custom_nodes', 'aeonquill_h3_memory')
  const staged = await stageH3NativeMemoryAddon(destination)
  assert.equal(staged.created, true)
  const lock = JSON.parse(await readFile(join(destination, 'source-lock.json'), 'utf8'))
  assert.deepEqual(lock.nodes, ['MiniMaxLowVRAMAttention', 'MiniMaxChunkFeedForward', 'MiniMaxReuseQKVAttention'])
  assert.equal(lock.addonRevision, 2)
  assert.equal(lock.sourceCommit, 'eaa8fee753faf37d1539804d89a46d3e0f40963d')
  assert.equal((await stageH3NativeMemoryAddon(destination)).created, false)
})

test('never overwrites a modified runtime package', async t => {
  const root = await temporary(t)
  const destination = join(root, 'custom_nodes', 'aeonquill_h3_memory')
  await stageH3NativeMemoryAddon(destination)
  const modified = join(destination, 'minimax_nodes.py')
  await writeFile(modified, '# user edit retained\n')
  await assert.rejects(stageH3NativeMemoryAddon(destination), error => error.code === 'H3_MEMORY_DESTINATION_MODIFIED')
  assert.equal(await readFile(modified, 'utf8'), '# user edit retained\n')
})

test('rejects an ambiguous destination before creating files', async t => {
  const root = await temporary(t)
  await assert.rejects(stageH3NativeMemoryAddon(join(root, 'UserData')), error => error.code === 'H3_MEMORY_DESTINATION_INVALID')
})

async function legacyPackage(t) {
  const root = await temporary(t)
  const destination = join(root, 'custom_nodes', 'aeonquill_h3_memory')
  await stageH3NativeMemoryAddon(destination)
  const fixture = JSON.parse(await readFile(new URL('./fixtures/h3-memory-v1.json', import.meta.url), 'utf8'))
  await writeFile(join(destination, '__init__.py'), fixture.init)
  await writeFile(join(destination, 'source-lock.json'), fixture.lock)
  await unlink(join(destination, 'attention_reuse.py'))
  return destination
}

test('requires an explicit upgrade and only replaces the exact known v1 package', async t => {
  const destination = await legacyPackage(t)
  await assert.rejects(stageH3NativeMemoryAddon(destination), error => error.code === 'H3_MEMORY_DESTINATION_MODIFIED')
  const result = await stageH3NativeMemoryAddon(destination, { upgradeKnown: true })
  assert.equal(result.upgraded, true)
  assert.equal(result.addonRevision, 2)
  assert.equal((await stageH3NativeMemoryAddon(destination)).created, false)
})

test('an explicit known upgrade still preserves user edits', async t => {
  const destination = await legacyPackage(t)
  const modified = join(destination, '__init__.py')
  await writeFile(modified, '# user edit retained\n')
  await assert.rejects(stageH3NativeMemoryAddon(destination, { upgradeKnown: true }), error => error.code === 'H3_MEMORY_DESTINATION_MODIFIED')
  assert.equal(await readFile(modified, 'utf8'), '# user edit retained\n')
})
