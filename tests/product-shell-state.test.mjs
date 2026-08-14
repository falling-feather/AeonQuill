import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createProductTarget,
  DEFAULT_BALANCED_PROJECT_ID,
  parseProductHash,
  parseShellPreferences,
  parseSmartVideoSession,
  resolveCollectionState,
  resolvePixelDraftEntry,
  serializeShellPreferences,
  serializeSmartVideoSession,
} from '../src/shell/productShellState.mjs'

test('product hash preserves a stable mode and encoded project reference', () => {
  assert.deepEqual(parseProductHash(''), { modeId: 'home', canonical: true })
  assert.deepEqual(parseProductHash('#/pixel'), { modeId: 'pixel', canonical: true })
  assert.deepEqual(parseProductHash('#/smart-video?project=story%20one'), {
    modeId: 'smart-video',
    projectId: 'story one',
    canonical: true,
  })
  assert.equal(
    createProductTarget('/studio', '?window=desktop', { modeId: 'balanced', projectId: 'local project' }),
    '/studio?window=desktop#/balanced?project=local+project',
  )
})

test('unknown or malformed hashes normalize safely to home', () => {
  assert.deepEqual(parseProductHash('#/unknown'), { modeId: 'home', canonical: false })
  assert.deepEqual(parseProductHash('#/pixel/extra'), { modeId: 'home', canonical: false })
  assert.deepEqual(parseProductHash('#/pixel?project=%00bad'), { modeId: 'home', canonical: false })
  assert.deepEqual(parseProductHash('#/home'), { modeId: 'home', canonical: false })
})

test('shell preferences keep UI selection and a stable balanced-project reference only', () => {
  const fallback = parseShellPreferences('{broken')
  assert.deepEqual(fallback, {
    version: 1,
    selectedModeId: 'balanced',
    balancedProjectId: DEFAULT_BALANCED_PROJECT_ID,
  })

  const serialized = serializeShellPreferences({
    version: 1,
    selectedModeId: 'pixel',
    balancedProjectId: 'project-42',
    copiedDocument: { forbidden: true },
  })
  assert.deepEqual(JSON.parse(serialized), {
    version: 1,
    selectedModeId: 'pixel',
    balancedProjectId: 'project-42',
  })
})

test('smart-video session stores source recovery data but never a private plan graph', () => {
  const serialized = serializeSmartVideoSession({
    version: 1,
    projectId: 'story-7',
    title: '河岸故事',
    sourceKind: 'script',
    sourceText: '场景 1：河岸\n镜头 1：晨光铺开。',
    updatedAt: 1_723_600_000_000,
    sceneCount: 1,
    taskCount: 4,
    plan: { tasks: ['must-not-persist'] },
  })
  const raw = JSON.parse(serialized)
  assert.equal('plan' in raw, false)
  assert.deepEqual(parseSmartVideoSession(serialized), raw)
  assert.equal(parseSmartVideoSession(JSON.stringify({ ...raw, sourceText: '' })), null)
  assert.equal(parseSmartVideoSession(JSON.stringify({ ...raw, sourceKind: 'unknown' })), null)
})

test('collection state distinguishes loading, error, empty, recovered and stable ready', () => {
  assert.equal(resolveCollectionState({ loading: true, error: false, itemCount: 0, recoveredCount: 0 }), 'loading')
  assert.equal(resolveCollectionState({ loading: false, error: true, itemCount: 1, recoveredCount: 1 }), 'error')
  assert.equal(resolveCollectionState({ loading: false, error: false, itemCount: 0, recoveredCount: 0 }), 'empty')
  assert.equal(resolveCollectionState({ loading: false, error: false, itemCount: 2, recoveredCount: 2 }), 'recovered')
  assert.equal(resolveCollectionState({ loading: false, error: false, itemCount: 2, recoveredCount: 0 }), 'ready')
})

test('pixel draft entry keeps a matching in-memory document usable after persistence failure', () => {
  assert.deepEqual(resolvePixelDraftEntry({
    requestedProjectId: 'large-draft',
    status: 'error',
    documentId: 'large-draft',
  }), {
    hasMemoryDocument: true,
    requestedDraftMissing: false,
    unreadable: false,
  })
  assert.equal(resolvePixelDraftEntry({
    requestedProjectId: 'old-draft',
    status: 'error',
    documentId: 'large-draft',
  }).requestedDraftMissing, true)
  assert.equal(resolvePixelDraftEntry({
    requestedProjectId: 'missing-draft',
    status: 'error',
  }).unreadable, true)
})
