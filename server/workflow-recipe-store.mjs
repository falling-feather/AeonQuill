import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertWorkflowRecipeCompatible, validateWorkflowRecipeInput, validateWorkflowRecipeRecord, migrateWorkflowRecipeRecord, WORKFLOW_RECIPE_SCHEMA_VERSION } from '../src/lib/workflowRecipes.mjs'

const MAX_RECIPES = 200
const MAX_BYTES = 512 * 1024
function fail(code, message, status = 400) { throw Object.assign(new Error(message), { code, status }) }
function clone(value) { return structuredClone(value) }

export class WorkflowRecipeStore {
  constructor(rootDirectory, { getWorkflow, now = Date.now, idFactory = () => `recipe-${randomUUID()}` } = {}) {
    this.rootDirectory = resolve(rootDirectory)
    this.path = join(this.rootDirectory, 'recipes.json')
    this.getWorkflow = getWorkflow
    this.now = now
    this.idFactory = idFactory
    this.state = { schemaVersion: WORKFLOW_RECIPE_SCHEMA_VERSION, revision: 0, recipes: [] }
    this.queue = Promise.resolve()
  }

  async open() {
    await mkdir(this.rootDirectory, { recursive: true })
    try {
      if ((await stat(this.path)).size > MAX_BYTES) throw new Error('oversized recipe store')
      const saved = JSON.parse(await readFile(this.path, 'utf8'))
      if (!saved || Object.keys(saved).sort().join(',') !== 'recipes,revision,schemaVersion'
        || ![1, WORKFLOW_RECIPE_SCHEMA_VERSION].includes(saved.schemaVersion) || !Number.isSafeInteger(saved.revision) || saved.revision < 0
        || !Array.isArray(saved.recipes) || saved.recipes.length > MAX_RECIPES) throw new Error('invalid recipe store')
      const recipes = saved.recipes.map((recipe) => migrateWorkflowRecipeRecord(recipe, saved.schemaVersion))
      if (new Set(recipes.map(({ id }) => id)).size !== recipes.length) throw new Error('duplicate recipe')
      this.state = { schemaVersion: WORKFLOW_RECIPE_SCHEMA_VERSION, revision: saved.revision, recipes }
    } catch (error) {
      if (error.code !== 'ENOENT') fail('WORKFLOW_RECIPE_STORE_CORRUPT', '配方文件损坏，已保留原文件，请检查或恢复该文件', 500)
    }
  }

  get(id) {
    const recipe = this.state.recipes.find((entry) => entry.id === id)
    if (!recipe) fail('WORKFLOW_RECIPE_NOT_FOUND', '配方不存在', 404)
    return clone(recipe)
  }

  list() {
    const statuses = { WORKFLOW_RECIPE_STALE: 'stale', WORKFLOW_RECIPE_WEIGHT_STALE: 'stale', WORKFLOW_RECIPE_DISABLED: 'disabled', WORKFLOW_RECIPE_MISSING: 'missing' }
    return {
      revision: this.state.revision,
      recipes: this.state.recipes.map((value) => {
        const recipe = clone(value)
        try {
          assertWorkflowRecipeCompatible(recipe, this.getWorkflow(recipe.workflowId))
          return { ...recipe, availability: 'ready', reason: null }
        } catch (error) {
          if (!statuses[error.code]) throw error
          return { ...recipe, availability: statuses[error.code], reason: error.message }
        }
      }),
    }
  }

  resolve(id) {
    const recipe = this.get(id)
    return assertWorkflowRecipeCompatible(recipe, this.getWorkflow(recipe.workflowId))
  }

  _mutate(action) {
    const next = this.queue.then(async () => {
      const candidate = clone(this.state)
      const result = action(candidate)
      candidate.revision += 1
      const content = `${JSON.stringify(candidate, null, 2)}\n`
      if (Buffer.byteLength(content) > MAX_BYTES) fail('WORKFLOW_RECIPE_LIMIT', '配方文件已达到容量上限', 413)
      const temporary = join(this.rootDirectory, `recipes-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', flush: true })
        await rename(temporary, this.path)
      } finally {
        await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error })
      }
      this.state = candidate
      return clone(result)
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  create(input) {
    return this._mutate((state) => {
      if (state.recipes.length >= MAX_RECIPES) fail('WORKFLOW_RECIPE_LIMIT', `最多保存 ${MAX_RECIPES} 份配方`, 409)
      const normalized = validateWorkflowRecipeInput(input, this.getWorkflow(input?.workflowId))
      const now = this.now()
      const recipe = validateWorkflowRecipeRecord({ id: this.idFactory(), ...normalized, createdAt: now, updatedAt: now })
      if (state.recipes.some(({ id }) => id === recipe.id)) fail('WORKFLOW_RECIPE_ID_CONFLICT', '配方 ID 已存在', 409)
      state.recipes.push(recipe)
      return recipe
    })
  }

  remove(id) {
    return this._mutate((state) => {
      const index = state.recipes.findIndex((recipe) => recipe.id === id)
      if (index < 0) fail('WORKFLOW_RECIPE_NOT_FOUND', '配方不存在', 404)
      state.recipes.splice(index, 1)
      return { id, removed: true }
    })
  }
}
