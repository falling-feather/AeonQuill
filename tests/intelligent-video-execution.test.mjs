import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { compileStoryProject, createGenerationPlan } from '../src/lib/story/storyProject.mjs'
import {
  CONTROLLED_H3_WORKFLOW_IDS,
  STORY_EXECUTION_LIMITS,
  assertVideoExecutionChecklist,
  assertVideoExecutionConfirmation,
  assertVideoExecutionSelectionRequest,
  compileConfirmedVideoRequests,
  createVideoExecutionChecklist,
  createVideoExecutionConfirmation,
} from '../src/lib/story/storyExecution.mjs'
import {
  INTELLIGENT_VIDEO_EXECUTION_MAX_BYTES,
  validateLlmExecutionSelection,
} from '../server/intelligent-video/execution-planner.mjs'

const SCRIPT = `场景 1：雨夜书店
镜头 1：全景，阿砚推门进入书店。
阿砚：我要找回遗失的一页。
镜头 2：缓慢推进到柜台，店主点亮墨锭。
店主：时间会替你翻页。`

const READY_RUNTIME = Object.freeze({
  bridgeAvailable: true,
  connected: true,
  ready: true,
  lifecycleState: 'ready',
  lifecyclePolicy: 'idle',
  vramTotalBytes: 8 * 1024 ** 3,
  missingNodes: [],
  missingModels: [],
  message: null,
})

const FIRST_FRAME_DATA_URL = 'data:image/png;base64,AA=='
const LAST_FRAME_DATA_URL = 'data:image/png;base64,AQ=='
const contentAddressedId = (bytes) => `sha256:${createHash('sha256').update(Uint8Array.from(bytes)).digest('hex')}`

const FIRST_ASSET = Object.freeze({
  schemaVersion: 1,
  bindingId: 'binding-first-001',
  assetVersionId: contentAddressedId([0]),
  role: 'first-frame',
  mimeType: 'image/png',
  status: 'ready',
})

const LAST_ASSET = Object.freeze({
  schemaVersion: 1,
  bindingId: 'binding-last-001',
  assetVersionId: contentAddressedId([1]),
  role: 'last-frame',
  mimeType: 'image/png',
  status: 'ready',
})

function fixture() {
  const project = compileStoryProject({
    kind: 'script',
    text: SCRIPT,
    aspectRatio: '16:9',
    frameStrategy: 'start-end',
    defaultShotSeconds: 6,
    now: 1_800_000_000_000,
  })
  return { project, plan: createGenerationPlan(project, { now: project.updatedAt }) }
}

function selection(shotId, overrides = {}) {
  return {
    shotId,
    mode: 'text-to-video',
    frameMode: 'none',
    preset: 'fast',
    audio: true,
    firstFrameBindingId: null,
    lastFrameBindingId: null,
    ...overrides,
  }
}

function checklistFor(selectionOverrides = {}, optionOverrides = {}) {
  const { project, plan } = fixture()
  const shotId = project.scenes[0].shots[0].id
  const checklist = createVideoExecutionChecklist(project, plan, {
    schemaVersion: 1,
    selections: [selection(shotId, selectionOverrides)],
  }, {
    now: 1_800_000_001_000,
    runtime: READY_RUNTIME,
    assets: [],
    ...optionOverrides,
  })
  return { project, plan, checklist }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

test('creates stable ready T2V checklist ids and deterministic H3 submission parameters', () => {
  const first = checklistFor()
  const second = checklistFor({}, { now: 1_900_000_000_000 })
  assert.equal(first.checklist.id, second.checklist.id)
  assert.equal(first.checklist.items[0].id, second.checklist.items[0].id)
  assert.notEqual(first.checklist.digest, second.checklist.digest)
  assert.equal(first.checklist.items[0].status, 'ready')
  assert.equal(first.checklist.items[0].workflowId, CONTROLLED_H3_WORKFLOW_IDS.textToVideo)
  assert.equal(first.checklist.items[0].request.duration, 10)
  const { digest, ...checklistPayload } = first.checklist
  assert.equal(digest, createHash('sha256').update(canonicalJson(checklistPayload), 'utf8').digest('hex'))

  const confirmation = createVideoExecutionConfirmation(first.checklist, {
    itemIds: [first.checklist.items[0].id],
    now: 1_800_000_002_000,
  })
  const [submission] = compileConfirmedVideoRequests(first.checklist, confirmation)
  assert.equal(submission.workflowId, CONTROLLED_H3_WORKFLOW_IDS.textToVideo)
  assert.equal(submission.request.mode, 'text-to-video')
  assert.equal(submission.request.aspectRatio, '16:9')
  assert.equal(submission.request.preset, 'fast')
  assert.match(submission.request.prompt, /雨夜书店/)
  assert.equal('sourceImageDataUrl' in submission.request, false)
  assert.match(submission.idempotencyKey, /^story-[a-f0-9]{48}$/)
})

test('sorts a bounded shot collection by story order and compiles one idempotent submission per item', () => {
  const { project, plan } = fixture()
  const [firstShot, secondShot] = project.scenes[0].shots
  const createBatch = (shotIds) => createVideoExecutionChecklist(project, plan, {
    schemaVersion: 1,
    selections: shotIds.map((shotId) => selection(shotId)),
  }, {
    now: 1_800_000_001_000,
    runtime: READY_RUNTIME,
    assets: [],
  })
  const reversed = createBatch([secondShot.id, firstShot.id])
  const ordered = createBatch([firstShot.id, secondShot.id])
  assert.equal(reversed.id, ordered.id)
  assert.deepEqual(reversed.items.map(({ shotId }) => shotId), [firstShot.id, secondShot.id])
  assert.deepEqual(reversed.items.map(({ ordinal }) => ordinal), [1, 2])
  assert.equal(new Set(reversed.items.map(({ planTaskId }) => planTaskId)).size, 2)

  const confirmation = createVideoExecutionConfirmation(reversed, {
    itemIds: reversed.items.map(({ id }) => id),
    now: 1_800_000_002_000,
  })
  const submissions = compileConfirmedVideoRequests(reversed, confirmation)
  assert.equal(submissions.length, 2)
  assert.equal(new Set(submissions.map(({ idempotencyKey }) => idempotencyKey)).size, 2)
})

test('marks missing first/last frames as real dependency blocks and never fabricates assets', () => {
  const missingFirst = checklistFor({
    mode: 'image-to-video',
    frameMode: 'first',
  }).checklist.items[0]
  assert.equal(missingFirst.status, 'blocked')
  assert.deepEqual(missingFirst.blocks.map(({ code }) => code), ['FIRST_FRAME_REQUIRED'])
  assert.equal(missingFirst.assetBindings.firstFrame, null)

  const missingLast = checklistFor({
    mode: 'image-to-video',
    frameMode: 'first-last',
    firstFrameBindingId: FIRST_ASSET.bindingId,
  }, { assets: [FIRST_ASSET] }).checklist.items[0]
  assert.equal(missingLast.status, 'blocked')
  assert.ok(missingLast.blocks.some(({ code }) => code === 'LAST_FRAME_REQUIRED'))
  assert.equal(missingLast.assetBindings.lastFrame, null)
})

test('compiles confirmed managed first/last assets into the existing I2V request fields', () => {
  const { checklist } = checklistFor({
    mode: 'image-to-video',
    frameMode: 'first-last',
    firstFrameBindingId: FIRST_ASSET.bindingId,
    lastFrameBindingId: LAST_ASSET.bindingId,
  }, { assets: [FIRST_ASSET, LAST_ASSET] })
  assert.equal(checklist.items[0].status, 'ready')
  assert.equal(checklist.items[0].workflowId, CONTROLLED_H3_WORKFLOW_IDS.imageToVideo)
  const confirmation = createVideoExecutionConfirmation(checklist, {
    itemIds: [checklist.items[0].id],
    now: 1_800_000_002_000,
  })
  const [submission] = compileConfirmedVideoRequests(checklist, confirmation, [
    { bindingId: FIRST_ASSET.bindingId, assetVersionId: FIRST_ASSET.assetVersionId, dataUrl: FIRST_FRAME_DATA_URL },
    { bindingId: LAST_ASSET.bindingId, assetVersionId: LAST_ASSET.assetVersionId, dataUrl: LAST_FRAME_DATA_URL },
  ])
  assert.equal(submission.request.mode, 'image-to-video')
  assert.equal(submission.request.sourceImageDataUrl, FIRST_FRAME_DATA_URL)
  assert.equal(submission.request.lastFrameImageDataUrl, LAST_FRAME_DATA_URL)
})

test('blocks insufficient VRAM, missing models, unavailable bridge, and manual stopped runtime', () => {
  const runtimes = [
    {
      ...READY_RUNTIME,
      vramTotalBytes: 7 * 1024 ** 3,
    },
    {
      ...READY_RUNTIME,
      ready: false,
      missingModels: ['minimax_h3_fl2va_pruned_fp8_scaled.safetensors'],
    },
    {
      ...READY_RUNTIME,
      bridgeAvailable: false,
      connected: false,
      ready: false,
      lifecycleState: 'unknown',
      lifecyclePolicy: null,
      vramTotalBytes: null,
      message: 'local bridge offline',
    },
    {
      ...READY_RUNTIME,
      connected: false,
      ready: false,
      lifecycleState: 'stopped',
      lifecyclePolicy: 'manual',
    },
  ]
  const expected = ['VRAM_INSUFFICIENT', 'MISSING_MODELS', 'BRIDGE_UNAVAILABLE', 'RUNTIME_MANUAL_STOPPED']
  runtimes.forEach((runtime, index) => {
    const item = checklistFor({}, { runtime }).checklist.items[0]
    assert.equal(item.status, 'blocked')
    assert.ok(item.blocks.some(({ code }) => code === expected[index]))
  })
})

test('rejects unknown selection fields, arbitrary workflow ids, and excessive batches', () => {
  const { project } = fixture()
  const shotId = project.scenes[0].shots[0].id
  assert.throws(
    () => assertVideoExecutionSelectionRequest({
      schemaVersion: 1,
      selections: [{ ...selection(shotId), workflowId: 'user.workflow.json' }],
    }),
    (error) => error.code === 'UNKNOWN_FIELD' && error.details.fields.includes('workflowId'),
  )
  assert.throws(
    () => validateLlmExecutionSelection(JSON.stringify({
      schemaVersion: 1,
      selections: [{ ...selection(shotId), comfyWorkflow: { nodes: [] } }],
    })),
    (error) => error.code === 'UNKNOWN_FIELD' && error.details.fields.includes('comfyWorkflow'),
  )
  assert.throws(
    () => validateLlmExecutionSelection('x'.repeat(INTELLIGENT_VIDEO_EXECUTION_MAX_BYTES + 1)),
    /exceeds 262144 bytes/,
  )
  assert.throws(
    () => assertVideoExecutionSelectionRequest({
      schemaVersion: 1,
      selections: Array.from(
        { length: STORY_EXECUTION_LIMITS.maxItems + 1 },
        (_, index) => selection(`shot-${index.toString().padStart(3, '0')}`),
      ),
    }),
    (error) => error.code === 'EXECUTION_ITEM_LIMIT',
  )
  const { checklist } = checklistFor()
  const arbitraryWorkflow = structuredClone(checklist)
  arbitraryWorkflow.items[0].workflowId = 'C:\\ComfyUI\\workflow.json'
  assert.throws(
    () => assertVideoExecutionChecklist(arbitraryWorkflow),
    (error) => error.code === 'UNCONTROLLED_WORKFLOW',
  )
})

test('rejects non-content-addressed ready frames and byte substitution under an unchanged asset id', () => {
  assert.throws(
    () => checklistFor({
      mode: 'image-to-video',
      frameMode: 'first',
      firstFrameBindingId: FIRST_ASSET.bindingId,
    }, { assets: [{ ...FIRST_ASSET, assetVersionId: 'asset-version-001' }] }),
    (error) => error.code === 'INVALID_ASSET_VERSION_ID',
  )

  const { checklist } = checklistFor({
    mode: 'image-to-video',
    frameMode: 'first',
    firstFrameBindingId: FIRST_ASSET.bindingId,
  }, { assets: [FIRST_ASSET] })
  const confirmation = createVideoExecutionConfirmation(checklist, {
    itemIds: [checklist.items[0].id],
    now: 1_800_000_002_000,
  })
  assert.throws(
    () => compileConfirmedVideoRequests(checklist, confirmation, [{
      bindingId: FIRST_ASSET.bindingId,
      assetVersionId: FIRST_ASSET.assetVersionId,
      dataUrl: LAST_FRAME_DATA_URL,
    }]),
    (error) => error.code === 'ASSET_PAYLOAD_CONTENT_MISMATCH',
  )
})

test('rejects modified checklists, stale confirmations, swapped payload metadata, and unused payloads', () => {
  const { checklist } = checklistFor({
    mode: 'image-to-video',
    frameMode: 'first',
    firstFrameBindingId: FIRST_ASSET.bindingId,
  }, { assets: [FIRST_ASSET] })
  const confirmation = createVideoExecutionConfirmation(checklist, {
    itemIds: [checklist.items[0].id],
    now: 1_800_000_002_000,
  })

  const changedPrompt = structuredClone(checklist)
  changedPrompt.items[0].request.prompt = '被确认后偷偷替换的提示词'
  assert.throws(
    () => assertVideoExecutionChecklist(changedPrompt),
    (error) => error.code === 'CHECKLIST_TAMPERED',
  )

  const changedConfirmation = structuredClone(confirmation)
  changedConfirmation.confirmedAt += 1
  assert.throws(
    () => assertVideoExecutionConfirmation(changedConfirmation, checklist),
    (error) => error.code === 'CONFIRMATION_TAMPERED',
  )

  assert.throws(
    () => compileConfirmedVideoRequests(checklist, confirmation, [{
      bindingId: FIRST_ASSET.bindingId,
      assetVersionId: LAST_ASSET.assetVersionId,
      dataUrl: LAST_FRAME_DATA_URL,
    }]),
    (error) => error.code === 'ASSET_PAYLOAD_MISMATCH',
  )
  assert.throws(
    () => compileConfirmedVideoRequests(checklist, confirmation, [
      { bindingId: FIRST_ASSET.bindingId, assetVersionId: FIRST_ASSET.assetVersionId, dataUrl: FIRST_FRAME_DATA_URL },
      { bindingId: LAST_ASSET.bindingId, assetVersionId: LAST_ASSET.assetVersionId, dataUrl: LAST_FRAME_DATA_URL },
    ]),
    (error) => error.code === 'UNUSED_ASSET_PAYLOAD',
  )
})
