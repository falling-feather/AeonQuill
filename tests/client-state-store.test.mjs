import assert from 'node:assert/strict'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { ClientStateStore } from '../server/client-state-store.mjs'
import { createPixelDocument, serializePixelDocument } from '../src/lib/pixel/pixelCore.mjs'
import { serializeSmartVideoSession } from '../src/shell/productShellState.mjs'

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-client-state-'))
  const resolved = resolve(root)
  assert.equal(resolved.startsWith(resolve(tmpdir())), true)
  try {
    const store = new ClientStateStore(root)
    await store.open()
    await run(store, root)
  } finally {
    await rm(resolved, { recursive: true, force: true })
  }
}

test('client state store round-trips strict shell, pixel and smart-video state', async () => {
  await withStore(async (store) => {
    const shellValue = JSON.stringify({
      version: 1,
      selectedModeId: 'pixel',
      balancedProjectId: 'project-7',
    })
    const pixelValue = serializePixelDocument(createPixelDocument({
      id: 'pixel-7',
      name: 'Pixel 7',
      width: 2,
      height: 2,
      palette: [{ id: 'ink', name: 'Ink', color: '#132035FF' }],
    }))
    const videoValue = serializeSmartVideoSession({
      version: 1,
      projectId: 'story-7',
      title: '纸上光阴',
      sourceKind: 'idea',
      sourceText: '墨迹化作一条时间河流。',
      updatedAt: 1_723_600_000_000,
      sceneCount: 1,
      taskCount: 3,
    })

    await store.put('shell-preferences', shellValue)
    await store.put('pixel-document', pixelValue)
    await store.put('smart-video-session', videoValue)

    assert.deepEqual(JSON.parse((await store.get('shell-preferences')).value), JSON.parse(shellValue))
    assert.deepEqual(JSON.parse((await store.get('pixel-document')).value), JSON.parse(pixelValue))
    assert.deepEqual(JSON.parse((await store.get('smart-video-session')).value), JSON.parse(videoValue))
  })
})

test('client state store rejects unknown kinds, unknown fields and oversize values', async () => {
  await withStore(async (store) => {
    await assert.rejects(() => store.get('../escape'), { code: 'UNKNOWN_CLIENT_STATE_KIND', status: 404 })
    await assert.rejects(() => store.put('shell-preferences', JSON.stringify({
      version: 1,
      selectedModeId: 'balanced',
      balancedProjectId: 'local-project',
      secretPath: 'C:\\Users\\private',
    })), { code: 'UNKNOWN_CLIENT_STATE_FIELD' })
    await assert.rejects(() => store.put('shell-preferences', 'x'.repeat(64 * 1024 + 1)), {
      code: 'CLIENT_STATE_TOO_LARGE',
      status: 413,
    })
  })
})

test('client state store uses fixed files, replaces atomically and rejects corrupt disk state', async () => {
  await withStore(async (store, root) => {
    const first = JSON.stringify({ version: 1, selectedModeId: 'balanced', balancedProjectId: 'one' })
    const second = JSON.stringify({ version: 1, selectedModeId: 'smart-video', balancedProjectId: 'two' })
    await store.put('shell-preferences', first)
    await store.put('shell-preferences', second)
    assert.equal(JSON.parse((await store.get('shell-preferences')).value).balancedProjectId, 'two')
    assert.deepEqual(await readdir(root), ['shell-preferences.json'])

    const path = join(root, 'shell-preferences.json')
    const wrapper = JSON.parse(await readFile(path, 'utf8'))
    wrapper.value = JSON.stringify({ ...JSON.parse(wrapper.value), injected: true })
    await writeFile(path, JSON.stringify(wrapper), 'utf8')
    await assert.rejects(() => store.get('shell-preferences'), { code: 'CLIENT_STATE_CORRUPT', status: 500 })
  })
})
