import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { JobStore } from '../server/job-store.mjs'
import { ProjectStore } from '../server/project-store.mjs'
import { StorageLifecycleError, StorageLifecycleService } from '../server/storage-lifecycle.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const testRoot = join(projectRoot, '.runtime', 'test-temp')
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQFe3gAAAABJRU5ErkJggg=='
const pixelVariant = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function canvasDocument(id, source) {
  return {
    schemaVersion: 1,
    id,
    title: id,
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    camera: { x: 0, y: 0, zoom: 1 },
    elements: [{
      id: `image-${id}`, kind: 'image', name: 'Image', x: 0, y: 0, width: 1, height: 1,
      rotation: 0, opacity: 1, radius: 0, fill: '#fff', stroke: '#000', src: source,
      sourceSrc: source, locked: false, visible: true, zIndex: 1,
    }],
  }
}

async function writeOld(filePath, contents, oldTime) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, contents)
  await utimes(filePath, oldTime, oldTime)
}

async function fixture(t) {
  await mkdir(testRoot, { recursive: true })
  const root = await mkdtemp(join(testRoot, 'storage-'))
  assert.equal(resolve(root).startsWith(resolve(testRoot)), true)
  const runtimeDirectory = join(root, 'runtime')
  const dataDirectory = join(root, 'data')
  const cacheDirectory = join(root, 'cache')
  const inputDirectory = join(runtimeDirectory, 'inputs')
  const assetDirectory = join(dataDirectory, 'assets')
  const outputDirectory = join(root, 'deliveries')
  const modelRoot = join(root, 'models', 'checkpoints')
  const nodeRoot = join(root, 'custom_nodes')
  const comfyDirectories = {
    input: join(dataDirectory, 'comfyui', 'input'),
    output: join(dataDirectory, 'comfyui', 'output'),
    temp: join(cacheDirectory, 'comfyui', 'temp'),
  }
  await Promise.all([
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(inputDirectory, { recursive: true }),
    mkdir(assetDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
    mkdir(modelRoot, { recursive: true }),
    mkdir(nodeRoot, { recursive: true }),
  ])
  const projectStore = await new ProjectStore(join(dataDirectory, 'project-store')).open()
  const jobStore = new JobStore(join(dataDirectory, 'jobs.json'))
  await jobStore.load()
  const workspaceReferences = {
    projectAssetIds: [],
    jobAssetFilenames: ['recovery-mask.png'],
    sources: { catalog: 1, currentDocuments: 1, recoveryPoints: 1 },
  }
  const workspaceStore = { storageReferences: () => structuredClone(workspaceReferences) }
  const removedPreviewAssets = []
  const service = await new StorageLifecycleService({
    rootDirectory: join(dataDirectory, 'storage-lifecycle'),
    runtimeDirectory,
    dataDirectory,
    cacheDirectory,
    inputDirectory,
    assetDirectory,
    outputDirectory,
    outputDirectorySource: 'custom',
    comfyDirectories,
    projectStore,
    workspaceStore,
    jobStore,
    getRuntimeRegistry: async () => ({
      modelRoots: [{
        id: 'root-models', path: modelRoot, label: '共享模型', category: 'checkpoints', shared: true,
        references: [{ type: 'extra-model-path' }],
      }],
      nodeRoots: [{
        id: 'root-nodes', path: nodeRoot, label: '本机节点', category: 'custom_nodes', shared: false,
        references: [{ type: 'comfy-root' }],
      }],
    }),
    onProjectAssetsRemoved: async (ids) => removedPreviewAssets.push(...ids),
  }).open()
  t.after(async () => {
    projectStore.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    runtimeDirectory,
    dataDirectory,
    cacheDirectory,
    inputDirectory,
    assetDirectory,
    outputDirectory,
    modelRoot,
    nodeRoot,
    comfyDirectories,
    projectStore,
    jobStore,
    workspaceReferences,
    removedPreviewAssets,
    service,
  }
}

test('storage policies use strict revision control and preserve final deliveries', async (t) => {
  const { service } = await fixture(t)
  const initial = service.getPolicy()
  assert.equal(initial.preserveDeliveries, true)
  const updated = await service.updatePolicy({
    baseRevision: initial.revision,
    retentionDays: {
      terminalInputs: 3,
      intermediateOutputs: 5,
      previewCache: 7,
      comfyResiduals: 2,
      projectOrphans: 15,
    },
    projectOverrides: { 'project-ad': { intermediateOutputs: 30 } },
  })
  assert.equal(updated.revision, initial.revision + 1)
  assert.equal(updated.projectOverrides['project-ad'].intermediateOutputs, 30)
  await assert.rejects(
    service.updatePolicy({ baseRevision: initial.revision, retentionDays: updated.retentionDays }),
    (error) => error instanceof StorageLifecycleError && error.code === 'STORAGE_POLICY_CONFLICT',
  )
  await assert.rejects(
    service.updatePolicy({ baseRevision: updated.revision, retentionDays: { ...updated.retentionDays, unexpected: 1 } }),
    (error) => error instanceof StorageLifecycleError && error.code === 'STORAGE_POLICY_INVALID',
  )
})

test('scan accounts for all managed classes while keeping active, rollback and delivery files protected', async (t) => {
  const context = await fixture(t)
  const {
    service, projectStore, jobStore, workspaceReferences, inputDirectory, assetDirectory,
    cacheDirectory, comfyDirectories, modelRoot, nodeRoot, outputDirectory,
  } = context
  const now = Date.now()
  const old = new Date(now - 3 * 24 * 60 * 60 * 1_000)
  const retention = Object.fromEntries(['terminalInputs', 'intermediateOutputs', 'previewCache', 'comfyResiduals', 'projectOrphans'].map((key) => [key, 1]))
  await service.updatePolicy({ baseRevision: 1, retentionDays: retention, projectOverrides: {} })

  const protectedProject = await projectStore.saveProject(canvasDocument('protected-project', pixel), { now: 1 })
  const orphanProject = await projectStore.saveProject(canvasDocument('orphan-project', pixelVariant), { now: 2 })
  await projectStore.deleteProject('protected-project')
  await projectStore.deleteProject('orphan-project')
  workspaceReferences.projectAssetIds = [protectedProject.assets[0].id]
  for (const asset of projectStore.storageInventory()) await utimes(projectStore.assetPath(asset), old, old)

  const oldInput = join(inputDirectory, 'job-terminal.png')
  const activeInput = join(inputDirectory, 'job-active.png')
  const intermediate = join(assetDirectory, 'job-terminal-native.mp4')
  const finalOutput = join(assetDirectory, 'job-terminal-720p.mp4')
  const recoveryMask = join(assetDirectory, 'recovery-mask.png')
  const preview = join(cacheDirectory, 'previews', 'old-preview.webp')
  const comfyResidual = join(comfyDirectories.output, 'AEONQUILL', 'old-output.mp4')
  const externalComfyOutput = join(comfyDirectories.output, 'other-user-output.mp4')
  const delivery = join(outputDirectory, 'job-terminal-720p.mp4')
  await Promise.all([
    writeOld(oldInput, 'old-input', old),
    writeOld(activeInput, 'active-input', old),
    writeOld(intermediate, 'intermediate', old),
    writeOld(finalOutput, 'final', old),
    writeOld(recoveryMask, 'mask', old),
    writeOld(preview, 'preview', old),
    writeOld(comfyResidual, 'comfy', old),
    writeOld(externalComfyOutput, 'external', old),
    writeOld(delivery, 'delivery', old),
    writeOld(join(modelRoot, 'model.safetensors'), 'model', old),
    writeOld(join(nodeRoot, 'node.py'), 'node', old),
  ])
  await jobStore.add({
    id: 'job-terminal', kind: 'video', status: 'completed', phase: 'completed', createdAt: 1,
    completedAt: 2, request: { projectId: 'project-ad' }, inputPath: oldInput, outputPath: finalOutput,
    outputUrl: '/api/assets/job-terminal-720p.mp4', maskUrl: '/api/assets/recovery-mask.png',
    intermediateOutputs: [{ filename: 'job-terminal-native.mp4', role: 'native-source' }],
    delivery: { status: 'copied', filename: 'job-terminal-720p.mp4' },
  })
  await jobStore.add({
    id: 'job-active', kind: 'image', status: 'running', phase: 'processing', createdAt: 3,
    request: { projectId: 'project-ad' }, inputPath: activeInput,
  })

  const scan = await service.scan()
  const candidateLabels = scan.candidates.map(({ label }) => label)
  assert.ok(candidateLabels.includes('过期任务输入'))
  assert.ok(candidateLabels.includes('过期中间母片'))
  assert.ok(candidateLabels.includes('可重建预览缓存'))
  assert.ok(candidateLabels.some((label) => label.includes('ComfyUI output')))
  assert.equal(scan.candidates.some(({ label }) => label.includes('最终')), false)
  assert.equal(scan.candidates.some(({ label }) => label.includes('recovery-mask')), false)
  assert.equal(scan.categories.find(({ id }) => id === 'models').candidateFiles, 0)
  assert.equal(scan.categories.find(({ id }) => id === 'models').roots[0].removalBlocked, true)
  assert.equal(scan.categories.find(({ id }) => id === 'deliveries').candidateFiles, 0)
  assert.equal(scan.safety.customOutputManualOnly, true)
  assert.equal(scan.safety.deliveriesPreserved, true)
  assert.equal(scan.references.recoveryPoints, 1)
  assert.equal(JSON.stringify(scan).includes(resolve(context.root)), false)
  assert.ok(scan.candidates.some(({ category, kind }) => category === 'project-assets' && kind === 'project-asset'))
  assert.equal(scan.candidates.filter(({ category }) => category === 'project-assets').length, 1)
  assert.equal(scan.capacity.totalBytes > 0, true)
  assert.equal(scan.estimates.length, 3)
})

test('cleanup requires an exact acknowledgement, rechecks every reference and verifies the resulting scan', async (t) => {
  const context = await fixture(t)
  const {
    service, projectStore, jobStore, workspaceReferences, inputDirectory, assetDirectory,
    cacheDirectory, comfyDirectories, removedPreviewAssets,
  } = context
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000)
  const retention = Object.fromEntries(['terminalInputs', 'intermediateOutputs', 'previewCache', 'comfyResiduals', 'projectOrphans'].map((key) => [key, 1]))
  await service.updatePolicy({ baseRevision: 1, retentionDays: retention, projectOverrides: {} })

  const orphanProject = await projectStore.saveProject(canvasDocument('cleanup-orphan', pixel), { now: 1 })
  await projectStore.deleteProject('cleanup-orphan')
  await utimes(projectStore.assetPath(projectStore.storageInventory()[0]), old, old)
  const oldInput = join(inputDirectory, 'cleanup-job.png')
  const intermediate = join(assetDirectory, 'cleanup-job-native.mp4')
  const preview = join(cacheDirectory, 'previews', 'cleanup-preview.webp')
  const comfyResidual = join(comfyDirectories.temp, 'AEONQUILL_cleanup-job', 'frame.tmp')
  await Promise.all([
    writeOld(oldInput, 'input', old),
    writeOld(intermediate, 'native', old),
    writeOld(preview, 'preview', old),
    writeOld(comfyResidual, 'temp', old),
  ])
  await jobStore.add({
    id: 'cleanup-job', kind: 'video', status: 'completed', phase: 'completed', createdAt: 1,
    request: { projectId: 'project-cleanup' }, inputPath: oldInput,
    intermediateOutputs: [{ filename: 'cleanup-job-native.mp4', role: 'native-source' }],
  })
  const scan = await service.scan({ includeRuntimeRoots: false })
  const selected = scan.candidates
  const acknowledgedBytes = selected.reduce((sum, candidate) => sum + candidate.bytes, 0)
  assert.ok(selected.length >= 4)
  assert.throws(
    () => service.validateCleanupRequest({
      scanId: scan.scanId,
      fingerprint: scan.fingerprint,
      candidateIds: selected.map(({ id }) => id),
      acknowledgedBytes: acknowledgedBytes + 1,
    }),
    (error) => error instanceof StorageLifecycleError && error.code === 'STORAGE_CLEANUP_ACK_MISMATCH',
  )

  await writeFile(preview, 'preview changed after scan')
  await unlink(comfyResidual)
  const result = await service.cleanup({
    scanId: scan.scanId,
    fingerprint: scan.fingerprint,
    candidateIds: selected.map(({ id }) => id),
    acknowledgedBytes,
  })
  assert.equal(result.verification.consistent, true)
  assert.equal(result.failures.length, 0)
  assert.ok(result.skipped.some(({ code }) => code === 'REFERENCE_CHANGED'))
  assert.ok(result.skipped.length >= 2)
  assert.equal(jobStore.get('cleanup-job').inputPath, undefined)
  assert.deepEqual(jobStore.get('cleanup-job').intermediateOutputs, [])
  assert.ok(jobStore.get('cleanup-job').storageLifecycle.expiredFiles.length >= 2)
  assert.equal(projectStore.getAsset(orphanProject.assets[0].id), null)
  assert.deepEqual(removedPreviewAssets, [orphanProject.assets[0].id])
  assert.equal((await readFile(preview, 'utf8')), 'preview changed after scan')
  workspaceReferences.jobAssetFilenames.push('cleanup-preview.webp')
})

test('an aborted cleanup preserves every candidate that has not started', async (t) => {
  const { service, cacheDirectory } = await fixture(t)
  const retention = Object.fromEntries(['terminalInputs', 'intermediateOutputs', 'previewCache', 'comfyResiduals', 'projectOrphans'].map((key) => [key, 1]))
  await service.updatePolicy({ baseRevision: 1, retentionDays: retention, projectOverrides: {} })
  const preview = join(cacheDirectory, 'previews', 'cancelled-preview.webp')
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000)
  await writeOld(preview, 'preserve-on-cancel', old)
  const scan = await service.scan({ includeRuntimeRoots: false })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    service.cleanup({
      scanId: scan.scanId,
      fingerprint: scan.fingerprint,
      candidateIds: scan.candidates.map(({ id }) => id),
      acknowledgedBytes: scan.totals.candidateBytes,
    }, { signal: controller.signal }),
    (error) => error.name === 'AbortError' && error.code === 'JOB_CANCELLED',
  )
  assert.equal(await readFile(preview, 'utf8'), 'preserve-on-cancel')
})
