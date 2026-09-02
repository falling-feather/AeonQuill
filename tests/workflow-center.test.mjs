import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  builtinWorkflowPacks,
  inspectCustomWorkflow,
  WorkflowCenterService,
} from '../server/workflow-center.mjs'

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function temporaryWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-workflow-center-'))
  const comfyRoot = join(root, 'ComfyUI')
  const stateRoot = join(root, 'state')
  await mkdir(comfyRoot, { recursive: true })
  return { root, comfyRoot, stateRoot }
}

async function waitForJob(service, jobId, expected = ['completed', 'failed', 'waiting-user'], timeoutMs = 5_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const job = service.job(jobId)
    if (expected.includes(job?.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for workflow job ${jobId}`)
}

async function payloadServer(payload, { corrupt = false } = {}) {
  let observedRange = null
  const server = createServer((request, response) => {
    observedRange = request.headers.range || null
    const source = corrupt ? Buffer.from(payload.map((value, index) => index === 0 ? value ^ 0xff : value)) : payload
    const offset = observedRange ? Number(/bytes=(\d+)-/u.exec(observedRange)?.[1] || 0) : 0
    const body = source.subarray(offset)
    response.writeHead(offset ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
      ...(offset ? { 'content-range': `bytes ${offset}-${source.length - 1}/${source.length}` } : {}),
    })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}/payload.bin`,
    observedRange: () => observedRange,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function fixturePack({ url, payload, manual = false }) {
  return {
    id: 'fixture-pack',
    version: '1.0.0',
    category: 'test',
    title: 'Fixture pack',
    summary: 'Small deterministic fixture',
    capabilities: ['test'],
    maturity: 'test',
    minVramGb: 1,
    recommendedVramGb: 1,
    minSystemRamGb: 1,
    estimatedMinutes: '<1',
    runtime: { minComfy: '0.1.0' },
    license: {
      id: 'fixture-license',
      name: 'Fixture',
      acceptanceRequired: false,
      commercialUse: 'test',
      redistribution: 'test',
      sourceUrl: 'https://example.com/license',
      notice: 'fixture',
    },
    artifacts: [
      {
        id: 'fixture-model',
        kind: 'model',
        label: 'Fixture model',
        relativePath: 'models/test/payload.bin',
        bytes: payload.length,
        sha256: digest(payload),
        downloadUrl: url,
        sourceUrl: 'https://example.com/payload',
        licenseId: 'fixture-license',
      },
      ...(manual ? [{
        id: 'fixture-extension',
        kind: 'manual-extension',
        label: 'Fixture extension',
        presentCandidates: ['custom_nodes/Fixture'],
        sourceUrl: 'https://example.com/extension',
        licenseId: 'fixture-license',
        instruction: 'Install fixture extension',
      }] : []),
    ],
    requiredNodes: ['FixtureNode'],
    sourceUrl: 'https://example.com',
  }
}

test('builtin workflow catalog exposes exact install, license, and RTX 4060 requirements', () => {
  const packs = builtinWorkflowPacks()
  assert.equal(packs.length, 5)
  const quality = packs.find(({ id }) => id === 'h3-quality-int8')
  assert.equal(quality.minVramGb, 8)
  assert.equal(quality.runtime.torchCudaFloor, 130)
  assert.equal(quality.license.acceptanceRequired, true)
  assert.equal(quality.license.redistribution, 'not-bundled-by-aeonquill')
  assert.equal(quality.artifacts.find(({ id }) => id === 'h3-fl2va-int8-convrot').sha256, 'e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a')
  assert.ok(packs.find(({ id }) => id === 'seedvr2-master720').artifacts.every(({ relativePath }) => relativePath.startsWith('models/')))
})

test('resumes a controlled download, verifies SHA-256, atomically installs, and enables the pack', async () => {
  const workspace = await temporaryWorkspace()
  const payload = Buffer.from('AEONQUILL deterministic workflow package payload')
  const endpoint = await payloadServer(payload)
  const pack = fixturePack({ url: endpoint.url, payload })
  const service = new WorkflowCenterService({ rootDirectory: workspace.stateRoot, getComfyRoot: () => workspace.comfyRoot, packs: [pack] })
  try {
    await service.open()
    const partialDirectory = join(workspace.stateRoot, 'downloads')
    await writeFile(join(partialDirectory, `${digest(payload)}.part`), payload.subarray(0, 11))
    const queued = await service.startInstall(pack.id, { acceptedLicenseIds: [], acknowledgedDiskBytes: payload.length })
    const completed = await waitForJob(service, queued.id)
    assert.equal(completed.status, 'completed')
    assert.equal(endpoint.observedRange(), 'bytes=11-')
    assert.deepEqual(await readFile(join(workspace.comfyRoot, 'models', 'test', 'payload.bin')), payload)
    const catalog = await service.catalog({
      runtime: { connected: true, comfyVersion: '0.31.0', pytorchVersion: '2.12.1+cu130', vramTotal: 8 * 1024 ** 3 },
      objectInfo: { FixtureNode: {} },
    })
    assert.equal(catalog.packs[0].ready, true)
    assert.equal(catalog.packs[0].integrityVerified, true)
    assert.equal(catalog.packs[0].recommendation.level, 'compatible')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(join(workspace.comfyRoot, 'models', 'test', 'payload.bin'), Buffer.from(payload.map((value, index) => index === 0 ? value ^ 0xff : value)))
    const changed = await service.catalog({
      runtime: { connected: true, comfyVersion: '0.31.0', pytorchVersion: '2.12.1+cu130', vramTotal: 8 * 1024 ** 3 },
      objectInfo: { FixtureNode: {} },
    })
    assert.equal(changed.packs[0].ready, false)
    assert.equal(changed.packs[0].status, 'error')
  } finally {
    await service.close()
    await endpoint.close()
    await rm(workspace.root, { recursive: true, force: true })
  }
})

test('quarantines a corrupt download and never exposes it as installed or enabled', async () => {
  const workspace = await temporaryWorkspace()
  const payload = Buffer.from('correct bytes with stable length')
  const endpoint = await payloadServer(payload, { corrupt: true })
  const pack = fixturePack({ url: endpoint.url, payload })
  const service = new WorkflowCenterService({ rootDirectory: workspace.stateRoot, getComfyRoot: () => workspace.comfyRoot, packs: [pack] })
  try {
    await service.open()
    const queued = await service.startInstall(pack.id, { acceptedLicenseIds: [], acknowledgedDiskBytes: payload.length })
    const failed = await waitForJob(service, queued.id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error.code, 'WORKFLOW_DOWNLOAD_HASH_MISMATCH')
    await assert.rejects(readFile(join(workspace.comfyRoot, 'models', 'test', 'payload.bin')))
    assert.equal((await readdir(join(workspace.stateRoot, 'quarantine'))).length, 1)
    const catalog = await service.catalog({ runtime: {}, objectInfo: {} })
    assert.equal(catalog.packs[0].enabled, false)
    assert.equal(catalog.packs[0].installed, false)
  } finally {
    await service.close()
    await endpoint.close()
    await rm(workspace.root, { recursive: true, force: true })
  }
})

test('downloads safe files but waits for explicit manual extensions before enabling', async () => {
  const workspace = await temporaryWorkspace()
  const payload = Buffer.from('manual dependency fixture')
  const endpoint = await payloadServer(payload)
  const pack = fixturePack({ url: endpoint.url, payload, manual: true })
  const service = new WorkflowCenterService({ rootDirectory: workspace.stateRoot, getComfyRoot: () => workspace.comfyRoot, packs: [pack] })
  try {
    await service.open()
    const queued = await service.startInstall(pack.id, { acceptedLicenseIds: [], acknowledgedDiskBytes: payload.length })
    const waiting = await waitForJob(service, queued.id)
    assert.equal(waiting.status, 'waiting-user')
    assert.equal(waiting.manualMissing[0].id, 'fixture-extension')
    const catalog = await service.catalog({ runtime: {}, objectInfo: {} })
    assert.equal(catalog.packs[0].enabled, false)
    assert.deepEqual(catalog.packs[0].missingArtifacts, ['fixture-extension'])
  } finally {
    await service.close()
    await endpoint.close()
    await rm(workspace.root, { recursive: true, force: true })
  }
})

test('custom workflow scanner fails closed on network nodes, unknown nodes, unsafe paths, and missing mappings', () => {
  const unsafe = inspectCustomWorkflow({
    workflow: {
      1: { class_type: 'HttpDownloadNode', inputs: { url: 'https://evil.example/model' } },
      2: { class_type: 'UnknownMagic', inputs: { ckpt_name: 'C:\\secret\\model.safetensors' } },
      3: { class_type: 'SaveImage', inputs: { filename_prefix: '../escape' } },
    },
    registeredNodeTypes: ['HttpDownloadNode'],
  })
  const codes = new Set(unsafe.findings.map(({ code }) => code))
  assert.equal(unsafe.canImport, false)
  assert.ok(codes.has('CUSTOM_WORKFLOW_NETWORK_NODE'))
  assert.ok(codes.has('CUSTOM_WORKFLOW_NETWORK_VALUE'))
  assert.ok(codes.has('CUSTOM_WORKFLOW_UNKNOWN_NODE'))
  assert.ok(codes.has('CUSTOM_WORKFLOW_UNSAFE_PATH'))
  assert.ok(codes.has('CUSTOM_WORKFLOW_MAPPINGS_REQUIRED'))
})

test('safe API workflow requires explicit mappings, persists by hash, and rechecks nodes before enabling', async () => {
  const workspace = await temporaryWorkspace()
  const service = new WorkflowCenterService({ rootDirectory: workspace.stateRoot, getComfyRoot: () => workspace.comfyRoot, packs: [] })
  const workflow = {
    1: { class_type: 'CLIPTextEncode', inputs: { text: 'ink product reveal' } },
    2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'AEONQUILL' } },
  }
  const mappings = { prompt: { nodeId: '1', inputName: 'text' }, output: { nodeId: '2' } }
  try {
    await service.open()
    const imported = await service.importCustom({ title: '受控图像工作流', workflow, mappings, registeredNodeTypes: ['CLIPTextEncode', 'SaveImage'] })
    assert.equal(imported.enabled, false)
    const duplicate = await service.importCustom({ title: '重复内容', workflow, mappings, registeredNodeTypes: ['CLIPTextEncode', 'SaveImage'] })
    assert.equal(duplicate.id, imported.id)
    const enabled = await service.setCustomEnabled(imported.id, true, ['CLIPTextEncode', 'SaveImage'])
    assert.equal(enabled.enabled, true)
    await assert.rejects(
      service.setCustomEnabled(imported.id, true, ['SaveImage']),
      (error) => error.code === 'CUSTOM_WORKFLOW_RECHECK_REQUIRED',
    )
    await service.close()
    const reopened = new WorkflowCenterService({ rootDirectory: workspace.stateRoot, getComfyRoot: () => workspace.comfyRoot, packs: [] })
    await reopened.open()
    assert.equal((await reopened.catalog()).customWorkflows[0].hash, imported.hash)
    await reopened.close()
  } finally {
    await rm(workspace.root, { recursive: true, force: true })
  }
})
