import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONTROLLED_WORKFLOW_IDS,
  STORY_LIMITS,
  assertGenerationPlan,
  assertStoryProject,
  compileStoryProject,
  createGenerationPlan,
  migrateStoryProject,
  parseStoryProjectCandidate,
} from '../src/lib/story/storyProject.mjs'
import {
  compileIntelligentVideoRequest,
  validateLlmStoryOutput,
} from '../server/intelligent-video/story-planner.mjs'

const SCRIPT = `场景 1：雨夜书店
镜头 1：全景，阿砚走进书店。
阿砚：我要找回遗失的一页。
镜头 2：推进到柜台，店主点亮墨锭。
店主：时间会替你翻页。

场景 2：黎明河岸
镜头 1：中景跟拍，阿砚沿河岸奔跑。
镜头 2：特写，阿砚把墨锭按在纸上。`

function compile(overrides = {}) {
  return compileStoryProject({
    kind: 'script',
    text: SCRIPT,
    aspectRatio: '16:9',
    frameStrategy: 'start-end',
    defaultShotSeconds: 5,
    now: 1_800_000_000_000,
    ...overrides,
  })
}

test('compiles normalized input into deterministic scenes, shots, actors, and stable ids', () => {
  const first = compile()
  const second = compile({
    text: SCRIPT.replace(/\n/g, '\r\n').replace('雨夜书店', '  雨夜书店  '),
    now: 1_900_000_000_000,
  })

  assert.equal(first.id, second.id)
  assert.deepEqual(first.scenes.map(({ id }) => id), second.scenes.map(({ id }) => id))
  assert.deepEqual(
    first.scenes.flatMap(({ shots }) => shots.map(({ id }) => id)),
    second.scenes.flatMap(({ shots }) => shots.map(({ id }) => id)),
  )
  assert.equal(first.scenes.length, 2)
  assert.equal(first.scenes.flatMap(({ shots }) => shots).length, 4)
  assert.deepEqual(first.characters.map(({ name }) => name), ['阿砚', '店主'])
  assert.deepEqual(first.scenes[0].shots[0].frameRoles, ['start', 'end'])
  assert.equal(first.scenes[0].shots[1].camera.movement, 'push-in')
  assert.equal(first.scenes[1].shots[1].camera.framing, 'close-up')
  assert.notEqual(first.createdAt, second.createdAt)

  const caseNormalized = compile({
    text: 'SCENE 1: Studio\nSHOT 1: Alice enters.\nALICE: Hello.\n\nSCENE 2: studio\nSHOT 1: Alice turns.\nalice: Goodbye.',
  })
  assert.equal(caseNormalized.characters.length, 1)
  assert.equal(caseNormalized.locations.length, 1)
})

test('builds a deterministic task DAG with controlled workflow ids and prior-stage dependencies', () => {
  const project = compile()
  const first = createGenerationPlan(project, { now: project.updatedAt })
  const second = createGenerationPlan(project, { now: project.updatedAt + 1_000 })
  const allowedWorkflows = new Set(Object.values(CONTROLLED_WORKFLOW_IDS))

  assert.equal(first.id, second.id)
  assert.deepEqual(first.tasks.map(({ id }) => id), second.tasks.map(({ id }) => id))
  assert.ok(first.tasks.every(({ workflowId }) => allowedWorkflows.has(workflowId)))
  assert.equal(first.tasks.filter(({ kind }) => kind === 'character-reference').length, 2)
  assert.equal(first.tasks.filter(({ kind }) => kind === 'location-reference').length, 2)
  assert.equal(first.tasks.filter(({ kind }) => kind === 'shot-frame').length, 8)
  assert.equal(first.tasks.filter(({ kind }) => kind === 'shot-video').length, 4)

  const byId = new Map(first.tasks.map((task) => [task.id, task]))
  for (const task of first.tasks) {
    for (const dependencyId of task.dependsOn) {
      const dependency = byId.get(dependencyId)
      assert.ok(dependency, `dependency ${dependencyId} exists`)
      assert.ok(
        first.stages.find(({ id }) => id === dependency.stage).order
          < first.stages.find(({ id }) => id === task.stage).order,
        `${task.kind} only depends on a prior stage`,
      )
    }
  }
  for (const task of first.tasks.filter(({ kind }) => kind === 'shot-video')) {
    assert.ok(task.dependsOn.length >= 1)
    assert.ok(task.dependsOn.every((id) => byId.get(id).kind === 'shot-frame'))
  }
  assert.equal(assertGenerationPlan(first, project), first)
})

test('rejects illegal, unknown, oversized, or structurally excessive inputs', () => {
  assert.throws(
    () => compile({ text: 'x'.repeat(STORY_LIMITS.maxSourceCharacters + 1) }),
    (error) => error.code === 'STRING_TOO_LONG',
  )
  const tooManyShots = [
    '场景 1：测试场景',
    ...Array.from({ length: STORY_LIMITS.maxShotsPerScene + 1 }, (_, index) => `镜头 ${index + 1}：固定画面。`),
  ].join('\n')
  assert.throws(
    () => compile({ text: tooManyShots }),
    (error) => error.code === 'SHOT_LIMIT',
  )
  const tooManyScenes = Array.from(
    { length: STORY_LIMITS.maxScenes + 1 },
    (_, index) => `第 ${index + 1} 段。`,
  ).join('\n\n')
  assert.throws(
    () => compile({ text: tooManyScenes }),
    (error) => error.code === 'SCENE_LIMIT',
  )
  assert.throws(
    () => compileIntelligentVideoRequest({
      schemaVersion: 1,
      kind: 'idea',
      text: '一束光穿过旧窗。',
      workflow: { arbitrary: true },
    }, { now: 1 }),
    /unsupported fields: workflow/,
  )
  assert.throws(
    () => compileIntelligentVideoRequest({
      schemaVersion: 1,
      kind: 'idea',
      text: 'x'.repeat(140_000),
    }, { now: 1 }),
    /exceeds 131072 bytes/,
  )
})

test('validates LLM candidates before use and rejects arbitrary execution fields', () => {
  const project = compile()
  assert.deepEqual(validateLlmStoryOutput(JSON.stringify(project)), project)
  assert.deepEqual(parseStoryProjectCandidate(project), project)

  const unsafeCandidate = structuredClone(project)
  unsafeCandidate.workflow = { nodes: [] }
  assert.throws(
    () => validateLlmStoryOutput(JSON.stringify(unsafeCandidate)),
    (error) => error.code === 'UNKNOWN_FIELD' && error.details.fields.includes('workflow'),
  )
  assert.throws(
    () => parseStoryProjectCandidate('{not-json'),
    (error) => error.code === 'INVALID_JSON',
  )
})

test('migrates the bounded legacy source contract through the current compiler', () => {
  const migrated = migrateStoryProject({
    schemaVersion: 0,
    id: 'legacy-story',
    title: '旧故事',
    sourceKind: 'script',
    sourceText: SCRIPT,
    aspectRatio: '9:16',
    frameStrategy: 'keyframe',
    defaultShotSeconds: 6,
    seed: 42,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
  })

  assert.equal(migrated.schemaVersion, 1)
  assert.equal(migrated.id, 'legacy-story')
  assert.equal(migrated.settings.aspectRatio, '9:16')
  assert.deepEqual(migrated.scenes[0].shots[0].frameRoles, ['key'])
  assert.equal(migrated.createdAt, 1_700_000_000_000)
  assert.equal(migrated.updatedAt, 1_700_000_000_100)
  assert.equal(assertStoryProject(migrated), migrated)
})

test('rejects tampered task plans and uncontrolled workflow ids', () => {
  const project = compile()
  const plan = createGenerationPlan(project)
  const tamperedWorkflow = structuredClone(plan)
  tamperedWorkflow.tasks[0].workflowId = 'user.supplied.workflow.json'
  assert.throws(
    () => assertGenerationPlan(tamperedWorkflow, project),
    (error) => error.code === 'UNCONTROLLED_WORKFLOW',
  )

  const tamperedDependency = structuredClone(plan)
  const videoTask = tamperedDependency.tasks.find(({ kind }) => kind === 'shot-video')
  videoTask.dependsOn = ['missing-task']
  assert.throws(
    () => assertGenerationPlan(tamperedDependency, project),
    (error) => error.code === 'DANGLING_DEPENDENCY',
  )
})
