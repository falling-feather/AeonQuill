import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { validateWorkflowRecipeInput, assertWorkflowRecipeCompatible } from '../src/lib/workflowRecipes.mjs'
import { WorkflowRecipeStore } from '../server/workflow-recipe-store.mjs'

const workflow = {
  id: 'custom-test', title: '图像编辑', enabled: true,
  hash: 'a'.repeat(64), mappingHash: 'b'.repeat(64),
  mappings: { prompt: { nodeId: '1', inputName: 'text' }, output: { nodeId: '2' }, steps: { nodeId: '3', inputName: 'steps' }, seed: { nodeId: '3', inputName: 'seed' } },
}
const input = (name = '我的配方') => ({ name, workflowId: workflow.id, workflowHash: workflow.hash, mappingHash: workflow.mappingHash, parameters: { seed: 12, steps: 8 } })
const hasCode = (code) => (error) => error.code === code

async function isolated(callback) {
  const parent = fileURLToPath(new URL('../.runtime/test-temp/', import.meta.url))
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'workflow-recipes-'))
  try { await callback(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('recipes save only mapped parameters and bind the exact workflow and mappings', () => {
  const value = validateWorkflowRecipeInput(input('  角色精修  '), workflow)
  assert.equal(value.name, '角色精修')
  assert.deepEqual(value.parameters, { seed: 12, steps: 8 })
  assert.notEqual(value.parameters, input().parameters)
  assert.throws(() => validateWorkflowRecipeInput({ ...input(), prompt: 'private' }, workflow), hasCode('INVALID_WORKFLOW_RECIPE'))
  assert.throws(() => validateWorkflowRecipeInput({ ...input(), parameters: { width: 512 } }, workflow), hasCode('RECIPE_PARAMETER_NOT_MAPPED'))
  assert.throws(() => validateWorkflowRecipeInput({ ...input(), parameters: { steps: 0 } }, workflow), hasCode('RECIPE_PARAMETER_RANGE'))
  assert.throws(() => validateWorkflowRecipeInput({ ...input(), parameters: { steps: 2.5 } }, workflow), hasCode('RECIPE_PARAMETER_RANGE'))
  assert.throws(() => validateWorkflowRecipeInput({ ...input(), parameters: { sourceImage: 'D:/private.png' } }, workflow), hasCode('INVALID_WORKFLOW_RECIPE'))
})

test('stale, disabled and removed workflow recipes are refused before applying settings', () => {
  const recipe = validateWorkflowRecipeInput(input(), workflow)
  assert.equal(assertWorkflowRecipeCompatible(recipe, workflow), recipe)
  assert.throws(() => assertWorkflowRecipeCompatible(recipe, { ...workflow, mappingHash: 'c'.repeat(64) }), hasCode('WORKFLOW_RECIPE_STALE'))
  assert.throws(() => assertWorkflowRecipeCompatible(recipe, { ...workflow, hash: 'c'.repeat(64) }), hasCode('WORKFLOW_RECIPE_STALE'))
  assert.throws(() => assertWorkflowRecipeCompatible(recipe, { ...workflow, enabled: false }), hasCode('WORKFLOW_RECIPE_DISABLED'))
  assert.throws(() => assertWorkflowRecipeCompatible(recipe, null), hasCode('WORKFLOW_RECIPE_MISSING'))
})

test('recipes round-trip supported fractional controls without accepting numeric coercion', () => {
  const controls = { ...workflow, mappings: { ...workflow.mappings, denoise: { nodeId: '3', inputName: 'denoise' }, loraStrength: { nodeId: '4', inputName: 'strength_model' } } }
  const value = validateWorkflowRecipeInput({ ...input(), parameters: { denoise: 0.35, loraStrength: -0.5 } }, controls)
  assert.deepEqual(value.parameters, { denoise: 0.35, loraStrength: -0.5 })
  assert.throws(() => validateWorkflowRecipeInput({ ...input(), parameters: { denoise: '0.35' } }, controls), hasCode('RECIPE_PARAMETER_RANGE'))
  assert.throws(() => validateWorkflowRecipeInput({ ...input(), workflowId: 123 }, controls), hasCode('INVALID_WORKFLOW_RECIPE'))
})

test('recipe store serializes concurrent writes and persists independent immutable values across reopen', () => isolated(async (root) => {
  const store = new WorkflowRecipeStore(root, { getWorkflow: () => workflow })
  await store.open()
  const recipes = await Promise.all([store.create(input('第一份')), store.create(input('第二份'))])
  assert.notEqual(recipes[0].id, recipes[1].id)
  recipes[0].parameters.steps = 199
  assert.equal(store.get(recipes[0].id).parameters.steps, 8)
  const reopened = new WorkflowRecipeStore(root, { getWorkflow: () => workflow })
  await reopened.open()
  assert.equal(reopened.list().recipes.length, 2)
  assert.equal(reopened.list().revision, 2)
  assert.deepEqual(reopened.resolve(recipes[0].id).parameters, { seed: 12, steps: 8 })
  await reopened.remove(recipes[0].id)
  assert.equal(reopened.list().recipes.length, 1)
  await assert.rejects(reopened.remove(recipes[0].id), hasCode('WORKFLOW_RECIPE_NOT_FOUND'))
  assert.equal(reopened.list().revision, 3)
}))

test('stored recipes remain visible with actionable status when their workflow changes', () => isolated(async (root) => {
  let current = workflow
  const store = new WorkflowRecipeStore(root, { getWorkflow: () => current })
  await store.open()
  const saved = await store.create(input())
  assert.equal(store.list().recipes[0].availability, 'ready')
  current = { ...workflow, hash: 'd'.repeat(64) }
  assert.equal(store.list().recipes[0].availability, 'stale')
  assert.throws(() => store.resolve(saved.id), hasCode('WORKFLOW_RECIPE_STALE'))
  current = null
  assert.equal(store.list().recipes[0].availability, 'missing')
  await assert.rejects(store.create(input()), hasCode('WORKFLOW_RECIPE_MISSING'))
  assert.equal(store.list().revision, 1)
}))

test('corrupt recipe files fail closed without replacing the original evidence', () => isolated(async (root) => {
  const path = join(root, 'recipes.json')
  await writeFile(path, '{bad', 'utf8')
  const store = new WorkflowRecipeStore(root, { getWorkflow: () => workflow })
  await assert.rejects(store.open(), hasCode('WORKFLOW_RECIPE_STORE_CORRUPT'))
  assert.equal(await readFile(path, 'utf8'), '{bad')
}))

test('failed atomic persistence does not publish a recipe or increment the in-memory revision', () => isolated(async (root) => {
  const store = new WorkflowRecipeStore(root, { getWorkflow: () => workflow })
  await store.open()
  await mkdir(join(root, 'recipes.json'))
  await assert.rejects(store.create(input()))
  assert.equal(store.list().revision, 0)
  assert.equal(store.list().recipes.length, 0)
}))
