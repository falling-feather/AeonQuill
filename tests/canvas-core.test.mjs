import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CanvasContractError,
  applyCanvasCommand,
  commitCanvasDraft,
  createCanvasCommand,
  createCanvasDocument,
  createCanvasDraft,
  executeCanvasTool,
  migrateCanvasDocument,
} from '../src/lib/canvasCore.mjs'

const camera = { x: 10, y: 20, zoom: 1 }
const element = {
  id: 'shape-1',
  kind: 'shape',
  name: 'Shape',
  x: 1,
  y: 2,
  width: 100,
  height: 80,
  rotation: 0,
  opacity: 1,
  radius: 8,
  fill: '#fff',
  stroke: '#000',
  locked: false,
  visible: true,
  zIndex: 1,
}

function makeDocument() {
  return createCanvasDocument({
    id: 'test-project',
    title: 'Test',
    elements: [element],
    camera,
    now: 100,
  })
}

test('migrates the legacy local-storage and version 2 export formats', () => {
  const local = migrateCanvasDocument({ elements: [element], camera }, { now: 200 })
  assert.equal(local.schemaVersion, 1)
  assert.equal(local.revision, 0)
  assert.deepEqual(local.elements, [element])

  const exported = migrateCanvasDocument({ version: 2, title: 'Legacy export', elements: [element], camera }, { now: 300 })
  assert.equal(exported.title, 'Legacy export')
  assert.equal(exported.createdAt, 300)
})

test('human and agent tool invocations produce the same validated document change', () => {
  const base = makeDocument()
  const input = { updates: [{ id: 'shape-1', patch: { x: 44, opacity: 0.8 } }] }
  const human = executeCanvasTool(base, {
    toolId: 'canvas.elements.patch', callId: 'human-1', actor: 'user', input,
  }, { now: 500 })
  const agent = executeCanvasTool(base, {
    toolId: 'canvas.elements.patch', callId: 'agent-1', actor: 'agent', input,
  }, { now: 500 })
  assert.deepEqual(human, agent)
  assert.equal(human.revision, 1)
  assert.equal(human.elements[0].x, 44)
})

test('rejects unsafe patches, stale revisions and whole-document agent replacement', () => {
  const base = makeDocument()
  assert.throws(() => executeCanvasTool(base, {
    toolId: 'canvas.elements.patch',
    callId: 'unsafe',
    actor: 'agent',
    input: { updates: [{ id: 'shape-1', patch: { id: 'hijacked' } }] },
  }), (error) => error instanceof CanvasContractError && error.code === 'UNSAFE_PATCH')

  const stale = createCanvasCommand(base, 'elements.patch', {
    updates: [{ id: 'shape-1', patch: { x: 9 } }],
  }, { id: 'stale', actor: 'user' })
  const advanced = applyCanvasCommand(base, createCanvasCommand(base, 'elements.patch', {
    updates: [{ id: 'shape-1', patch: { y: 8 } }],
  }, { id: 'advance', actor: 'user' }), { now: 600 })
  assert.throws(() => applyCanvasCommand(advanced, stale), (error) => error.code === 'REVISION_CONFLICT')

  assert.throws(() => executeCanvasTool(base, {
    toolId: 'canvas.elements.replace', callId: 'replace', actor: 'agent', input: { elements: [] },
  }), (error) => error.code === 'ACTOR_FORBIDDEN')

  assert.throws(() => executeCanvasTool(base, {
    toolId: 'canvas.elements.patch',
    callId: 'asset-hijack',
    actor: 'agent',
    input: { updates: [{ id: 'shape-1', patch: { src: 'https://example.test/tracker.png' } }] },
  }), (error) => error.code === 'ACTOR_FORBIDDEN')
})

test('agents cannot mutate locked elements or create generic media nodes', () => {
  const locked = createCanvasDocument({ elements: [{ ...element, locked: true }], camera, now: 1 })
  assert.throws(() => executeCanvasTool(locked, {
    toolId: 'canvas.elements.patch',
    callId: 'locked-patch',
    actor: 'agent',
    input: { updates: [{ id: 'shape-1', patch: { x: 99 } }] },
  }), (error) => error.code === 'ELEMENT_LOCKED')

  assert.throws(() => executeCanvasTool(makeDocument(), {
    toolId: 'canvas.elements.add',
    callId: 'media-add',
    actor: 'agent',
    input: { elements: [{ ...element, id: 'image-1', kind: 'image', src: 'data:image/png;base64,AA==' }] },
  }), (error) => error.code === 'ACTOR_FORBIDDEN')
})

test('draft commit is atomic and detects conflicts', () => {
  const base = makeDocument()
  const command = createCanvasCommand(base, 'elements.patch', {
    updates: [{ id: 'shape-1', patch: { x: 90 } }],
  }, { id: 'draft-command', actor: 'agent' })
  const draft = createCanvasDraft(base, [command], { id: 'draft-1', now: 700 })
  assert.equal(base.elements[0].x, 1)
  assert.equal(draft.preview.elements[0].x, 90)
  assert.equal(commitCanvasDraft(base, draft, { now: 800 }).elements[0].x, 90)

  const advanced = executeCanvasTool(base, {
    toolId: 'canvas.elements.patch',
    callId: 'advance-2',
    actor: 'user',
    input: { updates: [{ id: 'shape-1', patch: { y: 22 } }] },
  }, { now: 750 })
  assert.throws(() => commitCanvasDraft(advanced, draft), (error) => error.code === 'REVISION_CONFLICT')
})

test('connector integrity is preserved and deletions cascade', () => {
  const target = { ...element, id: 'shape-2', x: 200 }
  const connector = {
    ...element,
    id: 'connector-1',
    kind: 'connector',
    name: 'Connector',
    width: 0,
    height: 0,
    fromId: 'shape-1',
    toId: 'shape-2',
  }
  const base = createCanvasDocument({ elements: [element, target, connector], camera, now: 1 })
  const next = executeCanvasTool(base, {
    toolId: 'canvas.elements.remove',
    callId: 'remove-1',
    actor: 'user',
    input: { ids: ['shape-1'] },
  }, { now: 2 })
  assert.deepEqual(next.elements.map((item) => item.id), ['shape-2'])
})

test('accepts bounded embedded media while retaining stricter text limits', () => {
  const embedded = `data:image/png;base64,${'A'.repeat(300_000)}`
  const media = createCanvasDocument({
    elements: [{ ...element, id: 'image-large', kind: 'image', src: embedded }],
    camera,
    now: 1,
  })
  assert.equal(media.elements[0].src.length, embedded.length)
  assert.throws(() => createCanvasDocument({
    elements: [{ ...element, content: 'x'.repeat(200_001) }], camera, now: 1,
  }), (error) => error.code === 'STRING_TOO_LONG')
})

test('accepts a bounded normalized mask recipe in the processing stack', () => {
  const recipe = {
    schemaVersion: 1,
    strokes: [{
      id: 'mask-stroke-1',
      mode: 'remove',
      size: 0.08,
      hardness: 0.82,
      points: [{ x: 0.25, y: 0.3 }, { x: 0.6, y: 0.7 }],
    }],
  }
  const document = createCanvasDocument({
    elements: [{
      ...element,
      id: 'image-mask',
      kind: 'image',
      src: 'data:image/png;base64,AA==',
      processingStack: [{
        id: 'step-mask',
        type: 'mask-refine',
        label: '蒙版修边',
        detail: '1 笔',
        enabled: true,
        createdAt: 1,
        maskRecipe: recipe,
      }],
    }],
    camera,
    now: 1,
  })
  assert.deepEqual(document.elements[0].processingStack[0].maskRecipe, recipe)
})

test('rejects unsafe mask coordinates and unbounded processing metadata', () => {
  const maskElement = {
    ...element,
    id: 'image-mask-invalid',
    kind: 'image',
    src: 'data:image/png;base64,AA==',
    processingStack: [{
      id: 'step-mask',
      type: 'mask-refine',
      label: '蒙版修边',
      detail: '',
      enabled: true,
      createdAt: 1,
      maskRecipe: {
        schemaVersion: 1,
        strokes: [{
          id: 'stroke-outside',
          mode: 'restore',
          size: 0.08,
          hardness: 1,
          points: [{ x: 1.01, y: 0.5 }],
        }],
      },
    }],
  }
  assert.throws(
    () => createCanvasDocument({ elements: [maskElement], camera, now: 1 }),
    (error) => error.code === 'INVALID_NUMBER',
  )
  assert.throws(
    () => createCanvasDocument({
      elements: [{
        ...maskElement,
        processingStack: [{ ...maskElement.processingStack[0], hiddenPayload: true }],
      }],
      camera,
      now: 1,
    }),
    (error) => error.code === 'UNKNOWN_FIELD',
  )
})
