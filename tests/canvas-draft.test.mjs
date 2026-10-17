import assert from 'node:assert/strict'
import test from 'node:test'
import {
  discardCanvasDraft,
  discardCanvasDraftIfCurrent,
  enqueueCanvasProjectMutation,
  flushCanvasProjectMutation,
  getCanvasDraft,
  markCanvasDraftPersisted,
  queueCanvasDocumentSave,
  rememberCanvasDraft,
} from '../src/lib/canvasDraft.mjs'

function document(id, revision = 1) {
  return { id, title: id, revision }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('draft registry preserves object identity, ignores stale persistence, and supports explicit discard', () => {
  const oldDraft = document('draft-identity', 1)
  const newDraft = document('draft-identity', 2)
  rememberCanvasDraft(oldDraft)
  assert.strictEqual(getCanvasDraft(oldDraft.id), oldDraft)
  markCanvasDraftPersisted(document(oldDraft.id, 1))
  assert.strictEqual(getCanvasDraft(oldDraft.id), oldDraft)
  rememberCanvasDraft(newDraft)
  markCanvasDraftPersisted(oldDraft)
  assert.strictEqual(getCanvasDraft(newDraft.id), newDraft)
  assert.equal(discardCanvasDraftIfCurrent(newDraft.id, oldDraft), false)
  assert.equal(discardCanvasDraftIfCurrent(newDraft.id, newDraft), true)
  assert.equal(getCanvasDraft(newDraft.id), null)
  discardCanvasDraft(newDraft.id)
})

test('same object save reservations reuse one promise while different projects proceed independently', async () => {
  const first = document('draft-queue-a')
  const second = document('draft-queue-b')
  const gate = deferred()
  const events = []
  let saves = 0
  const firstPromise = queueCanvasDocumentSave(first, async () => {
    saves += 1
    events.push('a-start')
    await gate.promise
    events.push('a-end')
    return 'a-saved'
  })
  const duplicatePromise = queueCanvasDocumentSave(first, async () => {
    saves += 1
    return 'duplicate'
  })
  const secondPromise = queueCanvasDocumentSave(second, async () => {
    events.push('b')
    return 'b-saved'
  })
  assert.strictEqual(firstPromise, duplicatePromise)
  assert.deepEqual(await secondPromise, 'b-saved')
  assert.deepEqual(events, ['a-start', 'b'])
  assert.equal(saves, 1)
  assert.equal(getCanvasDraft(first.id), first)
  gate.resolve()
  assert.equal(await firstPromise, 'a-saved')
  assert.deepEqual(events, ['a-start', 'b', 'a-end'])
  assert.equal(getCanvasDraft(first.id), null)
  assert.equal(getCanvasDraft(second.id), null)
})

test('failed save keeps the draft and does not poison a later retry', async () => {
  const draft = document('draft-failure')
  await assert.rejects(
    queueCanvasDocumentSave(draft, async () => { throw new Error('write failed') }),
    /write failed/u,
  )
  assert.strictEqual(getCanvasDraft(draft.id), draft)
  assert.equal(await queueCanvasDocumentSave(draft, async () => 'retry-ok'), 'retry-ok')
  assert.equal(getCanvasDraft(draft.id), null)
})

test('late completion of an old save cannot clear a newer draft object', async () => {
  const oldDraft = document('draft-late', 1)
  const newDraft = document('draft-late', 2)
  const gate = deferred()
  const saving = queueCanvasDocumentSave(oldDraft, async () => {
    await gate.promise
    return 'old-ok'
  })
  rememberCanvasDraft(newDraft)
  gate.resolve()
  assert.equal(await saving, 'old-ok')
  assert.strictEqual(getCanvasDraft(newDraft.id), newDraft)
  discardCanvasDraft(newDraft.id)
})

test('project mutations are serialized per project and flush waits for the current tail', async () => {
  const gate = deferred()
  const events = []
  const first = enqueueCanvasProjectMutation('mutation-order', async () => {
    events.push('first-start')
    await gate.promise
    events.push('first-end')
    return 1
  })
  const second = enqueueCanvasProjectMutation('mutation-order', async () => {
    events.push('second')
    return 2
  })
  const flush = flushCanvasProjectMutation('mutation-order')
  await Promise.resolve()
  assert.deepEqual(events, ['first-start'])
  gate.resolve()
  assert.equal(await first, 1)
  assert.equal(await second, 2)
  await flush
  assert.deepEqual(events, ['first-start', 'first-end', 'second'])
})

test('conditional discard leaves a draft created while an import waits', () => {
  const projectId = 'draft-import'
  const oldDraft = document(projectId, 1)
  const newDraft = document(projectId, 2)
  rememberCanvasDraft(oldDraft)
  rememberCanvasDraft(newDraft)
  assert.equal(discardCanvasDraftIfCurrent(projectId, oldDraft), false)
  assert.strictEqual(getCanvasDraft(projectId), newDraft)
  discardCanvasDraft(projectId)
})
