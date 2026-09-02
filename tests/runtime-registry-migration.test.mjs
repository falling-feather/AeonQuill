import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseExtraModelPathsYaml } from '../server/runtime-registry.mjs'
import {
  planPortableConfigMigration,
  RuntimeRegistryMigrationService,
} from '../server/runtime-registry-migration.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const testRoot = join(projectRoot, '.runtime', 'tests')

function yamlFor(modelRoot) {
  return `shared_models:\n  base_path: ${modelRoot.replaceAll('\\', '/')}\n  diffusion_models: models/diffusion_models\n  vae: models/vae\n`
}

function resolvedFacts(source, configPath) {
  return parseExtraModelPathsYaml(source, { configPath }).entries
    .map(({ group, category, path }) => ({ group, category, path }))
    .sort((left, right) => left.category.localeCompare(right.category, 'en'))
}

async function fixture(t) {
  await mkdir(testRoot, { recursive: true })
  const directory = await mkdtemp(join(testRoot, 'registry-migration-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const comfyRoot = join(directory, 'runtime-candidates', 'candidate-v2', 'ComfyUI')
  const modelRoot = join(directory, 'runtime', 'stable-v1', 'ComfyUI')
  const configPath = join(comfyRoot, 'extra_model_paths.yaml')
  await mkdir(dirname(configPath), { recursive: true })
  await mkdir(join(modelRoot, 'models'), { recursive: true })
  const source = yamlFor(modelRoot)
  await writeFile(configPath, source, 'utf8')
  const registry = () => ({
    configFiles: [{ path: configPath, status: 'loaded' }],
    modelRoots: [{ id: 'root-models', label: '共享模型', references: [{ type: 'extra-model-config' }] }],
    nodeRoots: [],
    sharedRoots: [{ id: 'root-models', label: '共享模型', references: [{ type: 'extra-model-config' }] }],
  })
  return { directory, configPath, modelRoot, source, registry }
}

test('portable migration rewrites only base_path and preserves resolved model roots', async (t) => {
  const { configPath, source } = await fixture(t)
  const plan = planPortableConfigMigration(source, { configPath })
  assert.equal(plan.status, 'ready')
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].from, 'absolute')
  assert.equal(plan.changes[0].to, 'relative')
  assert.doesNotMatch(plan.migratedSource, /^[^\n]*base_path:\s*[A-Za-z]:/mu)
  assert.deepEqual(resolvedFacts(plan.migratedSource, configPath), resolvedFacts(source, configPath))
  assert.equal(
    plan.migratedSource.includes(relative(dirname(configPath), 'D:\\unrelated')),
    false,
  )
})

test('migration service supports preview, guarded apply, rollback and removal references', async (t) => {
  const { directory, configPath, source, registry } = await fixture(t)
  let mutationChecks = 0
  const service = new RuntimeRegistryMigrationService({
    rootDirectory: join(directory, 'state'),
    getRegistry: async () => registry(),
    assertMutationAllowed: async () => { mutationChecks += 1 },
  })
  await service.open()
  const preview = await service.preview()
  assert.equal(preview.status, 'ready')
  assert.equal(preview.movesModelFiles, false)
  assert.equal(preview.readyCount, 1)
  assert.equal(preview.removalGate.blockedRoots, 1)
  assert.equal(JSON.stringify(preview).includes(directory), false, 'public preview must not expose disk paths')

  const plan = preview.plans[0]
  const applied = await service.apply({ planId: plan.id, beforeHash: plan.beforeHash })
  assert.equal(applied.record.status, 'applied')
  assert.equal(applied.record.rollbackAvailable, true)
  assert.equal(applied.preview.status, 'not-needed')
  const migratedSource = await readFile(configPath, 'utf8')
  assert.notEqual(migratedSource, source)
  assert.deepEqual(resolvedFacts(migratedSource, configPath), resolvedFacts(source, configPath))

  const removal = await service.checkRemoval({ rootId: 'root-models' })
  assert.deepEqual(removal, {
    rootId: 'root-models',
    rootLabel: '共享模型',
    blocked: true,
    referenceCount: 1,
    reasons: ['extra-model-config'],
  })

  const rolledBack = await service.rollback({ recordId: applied.record.id })
  assert.equal(rolledBack.record.status, 'rolled-back')
  assert.equal(await readFile(configPath, 'utf8'), source)
  assert.equal(mutationChecks, 2)
})

test('migration apply rejects a stale preview without overwriting the config', async (t) => {
  const { directory, configPath, registry } = await fixture(t)
  const service = new RuntimeRegistryMigrationService({
    rootDirectory: join(directory, 'state'),
    getRegistry: async () => registry(),
  })
  await service.open()
  const plan = (await service.preview()).plans[0]
  const changed = `${await readFile(configPath, 'utf8')}# changed after preview\n`
  await writeFile(configPath, changed, 'utf8')
  await assert.rejects(
    service.apply({ planId: plan.id, beforeHash: plan.beforeHash }),
    (error) => ['RUNTIME_MIGRATION_PLAN_STALE', 'RUNTIME_MIGRATION_CONFIG_CHANGED'].includes(error.code),
  )
  assert.equal(await readFile(configPath, 'utf8'), changed)
})
