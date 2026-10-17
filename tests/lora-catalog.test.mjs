import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { LoraCatalog } from '../server/lora-catalog.mjs'

const testRoot = resolve('.runtime', 'tests')

async function withTempDirectory(callback) {
  await mkdir(testRoot, { recursive: true })
  const root = await mkdtemp(join(testRoot, 'lora-catalog-'))
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function makeSafetensors({ family = 'sd_v1', validPair = true } = {}) {
  const metadata = family === undefined ? {} : { ss_base_model_version: family }
  const entries = {}
  const data = []
  let offset = 0
  const add = (name, shape) => {
    const bytes = shape.reduce((total, value) => total * value, 2)
    entries[name] = { dtype: 'F16', shape, data_offsets: [offset, offset + bytes] }
    data.push(Buffer.alloc(bytes))
    offset += bytes
  }
  add('unet.lora_A.weight', [2, 2])
  add('unet.lora_B.weight', validPair ? [2, 2] : [3, 3])
  const header = Buffer.from(JSON.stringify({ __metadata__: metadata, ...entries }), 'utf8')
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(header.length), 0)
  return Buffer.concat([length, header, ...data])
}

async function writeModel(root, relativeName, options) {
  const file = join(root, ...relativeName.split('/'))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, makeSafetensors(options))
  return file
}

function modelByName(catalog, name) {
  return catalog.models.find((model) => model.name === name)
}

test('lists stable root-indexed ids, keeps same names from different roots distinct, and warns for missing roots', async () => {
  await withTempDirectory(async (root) => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    const missing = join(root, 'missing')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeModel(first, 'style/model.safetensors', { family: 'sd_v1' })
    await writeModel(second, 'style/model.safetensors', { family: 'sd_v1' })
    const catalog = await new LoraCatalog({ roots: [first, second, missing], storeRoot: join(root, 'store') }).open()
    const result = await catalog.list()
    assert.equal(result.models.length, 2)
    assert.equal(result.models[0].name, 'style/model.safetensors')
    assert.equal(result.models[1].name, 'style/model.safetensors')
    assert.notEqual(result.models[0].id, result.models[1].id)
    assert.ok(result.warnings.includes('LORA_ROOT_MISSING:2'))
    assert.equal(JSON.stringify(result).includes(root), false)
    const again = await catalog.list()
    assert.deepEqual(again.models, result.models)
  })
})

test('does not follow symlinks and enforces depth and scan budgets with precise warnings', async (t) => {
  await withTempDirectory(async (root) => {
    const dataRoot = join(root, 'data')
    await mkdir(dataRoot, { recursive: true })
    await writeModel(dataRoot, 'a/b/c/d/too-deep.safetensors', { family: 'sd_v1' })
    const outsideRoot = await mkdtemp(join(testRoot, 'lora-catalog-outside-'))
    try {
      const outside = await writeModel(outsideRoot, 'outside.safetensors', { family: 'sd_v1' })
      try {
        await symlink(outside, join(dataRoot, 'escape.safetensors'), 'file')
      } catch (error) {
        if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error
        t.diagnostic('symlink creation unavailable; depth and budget checks still run')
      }
      for (let index = 0; index < 1_001; index += 1) {
        await writeModel(dataRoot, 'bulk/' + String(index).padStart(4, '0') + '.safetensors', { family: 'sd_v1' })
      }
      const catalog = await new LoraCatalog({ roots: [dataRoot], storeRoot: join(root, 'store') }).open()
      const result = await catalog.list()
      assert.ok(result.warnings.some((warning) => warning.startsWith('LORA_SCAN_DEPTH_LIMIT:0:a/b/c/d')))
      assert.ok(result.warnings.includes('LORA_SCAN_ENTRY_LIMIT:0'))
      assert.ok(result.warnings.some((warning) => warning.startsWith('LORA_MODEL_LIMIT:0:bulk/')))
      assert.equal(result.models.some((model) => model.name.includes('escape.safetensors')), false)
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })
})

test('inspects, saves, refreshes and resolves a binding from the small atomic store', async () => {
  await withTempDirectory(async (root) => {
    const modelsRoot = join(root, 'models')
    const storeRoot = join(root, 'store')
    await mkdir(modelsRoot, { recursive: true })
    await writeModel(modelsRoot, 'character.safetensors', { family: 'sd_v1' })
    const catalog = await new LoraCatalog({ roots: [modelsRoot], storeRoot }).open()
    const listed = await catalog.list()
    const model = modelByName(listed, 'character.safetensors')
    const inspectedWithoutExpectedFamily = await catalog.inspect({ modelId: model.id })
    assert.equal(inspectedWithoutExpectedFamily.inspection.family, 'sd15')
    assert.equal(inspectedWithoutExpectedFamily.inspection.compatibility, 'compatible')
    const inspected = await catalog.inspect({ modelId: model.id, expectedFamily: 'sd15' })
    assert.equal(inspected.inspection.compatibility, 'compatible')
    const saved = await catalog.saveBinding({
      modelId: model.id,
      role: 'character',
      expectedFamily: 'sd15',
      strength: 1,
      clipStrength: 0.75,
      triggerWords: ['aeon-character'],
    })
    assert.equal(saved.modelName, 'character.safetensors')
    assert.equal(saved.binding.family, 'sd15')
    assert.deepEqual(await catalog.saveBinding({
      modelId: model.id,
      role: 'character',
      expectedFamily: 'sd15',
      strength: 1,
      clipStrength: 0.75,
      triggerWords: ['aeon-character'],
    }), saved)
    const stored = await catalog.listBindings()
    assert.equal(stored.bindings.length, 1)
    assert.equal(stored.bindings[0].binding.id, saved.binding.id)
    const refreshed = await new LoraCatalog({ roots: [modelsRoot], storeRoot }).open()
    assert.deepEqual(await refreshed.listBindings(), stored)
    assert.deepEqual(await refreshed.resolveBinding(saved.binding.id, 'sd15'), stored.bindings[0])
    const rawStore = JSON.parse(await readFile(join(storeRoot, 'bindings.json'), 'utf8'))
    assert.equal(rawStore.schemaVersion, 1)
    assert.equal(rawStore.revision, 1)
  })
})

test('preserves corrupt store files and fails closed', async () => {
  await withTempDirectory(async (root) => {
    const modelsRoot = join(root, 'models')
    const storeRoot = join(root, 'store')
    await mkdir(modelsRoot, { recursive: true })
    await mkdir(storeRoot, { recursive: true })
    const storePath = join(storeRoot, 'bindings.json')
    const corrupt = '{ not valid json }\n'
    await writeFile(storePath, corrupt, 'utf8')
    await assert.rejects(() => new LoraCatalog({ roots: [modelsRoot], storeRoot }).open(), { code: 'LORA_CATALOG_STORE_CORRUPT' })
    assert.equal(await readFile(storePath, 'utf8'), corrupt)
  })
})

test('rejects changed model content on resolve and never saves unknown family', async () => {
  await withTempDirectory(async (root) => {
    const modelsRoot = join(root, 'models')
    const storeRoot = join(root, 'store')
    await mkdir(modelsRoot, { recursive: true })
    const file = await writeModel(modelsRoot, 'mutable.safetensors', { family: 'sd_v1' })
    const catalog = await new LoraCatalog({ roots: [modelsRoot], storeRoot }).open()
    const model = modelByName(await catalog.list(), 'mutable.safetensors')
    const saved = await catalog.saveBinding({ modelId: model.id, role: 'style', expectedFamily: 'sd15', strength: 1 })
    const bytes = await readFile(file)
    bytes[bytes.length - 1] ^= 1
    await writeFile(file, bytes)
    await assert.rejects(() => catalog.resolveBinding(saved.binding.id, 'sd15'), { code: 'LORA_SHA256_MISMATCH' })

    const unknownFile = await writeModel(modelsRoot, 'unknown.safetensors', { family: 'unknown' })
    const unknownModel = modelByName(await catalog.list(), 'unknown.safetensors')
    await assert.rejects(() => catalog.saveBinding({ modelId: unknownModel.id, role: 'style', expectedFamily: 'sd15', strength: 1 }), { code: 'LORA_COMPATIBILITY_UNVERIFIED' })
    assert.ok(unknownFile)
    await assert.rejects(() => catalog.saveBinding({ modelId: unknownModel.id, role: 'style', expectedFamily: 'sd15', strength: 2.1 }), { code: 'WORKFLOW_CONTROL_VALUE_RANGE' })
  })
})

test('rejects relative or arbitrary roots before scanning', async () => {
  assert.throws(() => new LoraCatalog({ roots: ['relative'], storeRoot: resolve('.runtime', 'tests') }), { code: 'LORA_CATALOG_ROOT_INVALID' })
  assert.throws(() => new LoraCatalog({ roots: [resolve('.runtime', 'tests')], storeRoot: 'relative' }), { code: 'LORA_CATALOG_ROOT_INVALID' })
})
