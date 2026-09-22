import assert from 'node:assert/strict'
import test from 'node:test'
import { createVideoProductionProject } from '../src/lib/story/productionPipeline.mjs'
import { createMediaRunProposal } from '../src/lib/story/mediaSupervisor.mjs'
import { mediaJobFingerprint } from '../src/lib/story/mediaJobBinding.mjs'
import { prepareMediaJobEnvelope } from '../server/media-job-binding.mjs'

async function fixture() {
  const body = { mode: 'text-to-video', prompt: 'A calm portrait', duration: 5, preset: 'fast', candidateBinding: { projectId: 'workspace-1', documentId: 'story-1', productionRevision: 0, submissionId: 'proposal', shotId: 'shot-1' } }
  const production = createVideoProductionProject({ now: 1000 })
  for (const node of production.nodes) {
    if (node.id === 'video-director') { node.status = 'ready'; break }
    node.status = 'approved'; node.outputSummary ||= 'approved'
  }
  const inputFingerprint = await mediaJobFingerprint('video', body)
  const run = createMediaRunProposal({ nodeId: 'video-director', kind: 'video', targetId: 'shot-1', inputFingerprint, requestSummary: '本地近景，5秒，快速预览' }, { now: 1001 })
  production.mediaRuns = [run]
  const binding = { projectId: 'workspace-1', documentId: 'story-1', runId: run.id, inputFingerprint }
  const workspaceStore = {
    getCatalog: () => ({ catalog: { projects: [{ id: 'workspace-1', status: 'active', documents: [{ id: 'story-1', modeId: 'smart-video' }] }] } }),
    getModeDocument: () => ({ projectId: 'workspace-1', modeId: 'smart-video', value: JSON.stringify({ production }) }),
  }
  return { body, binding, production, workspaceStore }
}

test('media request hash binds actual inputs while excluding only proposal bookkeeping', async () => {
  const { body } = await fixture()
  assert.equal(await mediaJobFingerprint('video', body), await mediaJobFingerprint('video', { ...body, candidateBinding: { ...body.candidateBinding, productionRevision: 2, submissionId: 'confirmed' } }))
  assert.notEqual(await mediaJobFingerprint('video', body), await mediaJobFingerprint('video', { ...body, duration: 10 }))
})

test('media binding is revalidated against stored approvals and parameters before queueing', async () => {
  const { body, binding, production, workspaceStore } = await fixture()
  const result = await prepareMediaJobEnvelope({ ...body, mediaBinding: binding }, ['video'], { workspaceStore })
  assert.deepEqual(result.body, body)
  assert.deepEqual(result.mediaBinding, binding)
  assert.match(result.idempotencyKey, /^media-run-[a-f0-9]{64}$/)
  await assert.rejects(prepareMediaJobEnvelope({ ...body, duration: 10, mediaBinding: binding }, ['video'], { workspaceStore }), { code: 'MEDIA_JOB_INPUT_CHANGED' })
  await assert.rejects(prepareMediaJobEnvelope({ ...body, mediaBinding: { ...binding, extra: 'x' } }, ['video'], { workspaceStore }), { code: 'MEDIA_JOB_BINDING_INVALID' })
  await assert.rejects(prepareMediaJobEnvelope({ ...body, mediaBinding: binding }, ['image'], { workspaceStore }), { code: 'MEDIA_JOB_KIND_MISMATCH' })
  production.globalPaused = true
  await assert.rejects(prepareMediaJobEnvelope({ ...body, mediaBinding: binding }, ['video'], { workspaceStore }), { code: 'MEDIA_PROJECT_PAUSED' })
})

test('legacy direct job requests retain their existing validation path', async () => {
  const body = { prompt: 'legacy' }
  const result = await prepareMediaJobEnvelope(body, ['video'], {})
  assert.equal(result.body, body)
  assert.equal(result.mediaBinding, undefined)
})
