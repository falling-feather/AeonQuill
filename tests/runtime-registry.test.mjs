import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  discoverRuntimeRegistry,
  extraModelConfigPaths,
  parseExtraModelPathsYaml,
  registeredArtifactCandidates,
} from '../server/runtime-registry.mjs'
import { WorkflowCenterService } from '../server/workflow-center.mjs'

function portablePath(pathname) {
  return pathname.replace(/\\/gu, '/')
}

async function temporaryRuntime() {
  const root = await mkdtemp(join(tmpdir(), 'aeonquill-runtime-registry-'))
  const comfyRoot = join(root, 'current', 'ComfyUI')
  const sharedRoot = join(root, 'shared-runtime', 'ComfyUI')
  const stateRoot = join(root, 'state')
  await Promise.all([
    mkdir(comfyRoot, { recursive: true }),
    mkdir(sharedRoot, { recursive: true }),
  ])
  return { root, comfyRoot, sharedRoot, stateRoot }
}

test('parses ComfyUI extra model path groups, multiline roots, variables, and relative bases', () => {
  const configPath = join('D:\\portable', 'ComfyUI', 'extra_model_paths.yaml')
  const parsed = parseExtraModelPathsYaml(`
shared:
  base_path: '%AEON_TEST_ROOT%/ComfyUI'
  is_default: true
  diffusion_models: |
    models/diffusion_models
    models/alternate
relative:
  base_path: ../shared
  sams: models/sams
`, {
    configPath,
    environment: { AEON_TEST_ROOT: 'D:/models' },
    homeDirectory: 'D:/home',
  })
  assert.equal(parsed.entries.length, 3)
  assert.equal(parsed.entries[0].category, 'diffusion_models')
  assert.equal(parsed.entries[0].path, join('D:\\models', 'ComfyUI', 'models', 'diffusion_models'))
  assert.equal(parsed.entries[0].isDefault, true)
  assert.equal(parsed.entries[0].portable, false)
  assert.equal(parsed.entries[2].path, join('D:\\portable', 'shared', 'models', 'sams'))
  assert.equal(parsed.entries[2].portable, true)
})

test('discovers default and explicit config files without duplicating paths', () => {
  const comfyRoot = 'D:\\runtime\\ComfyUI'
  const paths = extraModelConfigPaths({
    comfyRoot,
    comfyArgs: [
      'main.py',
      '--extra-model-paths-config',
      'extra_model_paths.yaml',
      'D:\\registry\\models.yaml',
      '--listen',
      '127.0.0.1',
    ],
  })
  assert.equal(paths.filter((pathname) => pathname.endsWith('extra_model_paths.yaml')).length, 1)
  assert.ok(paths.includes('D:\\registry\\models.yaml'))
})

test('shared model roots are explicit, reverse-referenced, and used for artifact resolution', async () => {
  const workspace = await temporaryRuntime()
  try {
    await writeFile(join(workspace.comfyRoot, 'extra_model_paths.yaml'), `shared:\n  base_path: ${portablePath(workspace.sharedRoot)}\n  diffusion_models: models/diffusion_models\n`, 'utf8')
    await mkdir(join(workspace.sharedRoot, 'models', 'diffusion_models'), { recursive: true })
    const registry = await discoverRuntimeRegistry({
      comfyRoot: workspace.comfyRoot,
      modelCategories: ['diffusion_models'],
    })
    assert.match(registry.registryHash, /^[a-f0-9]{64}$/u)
    assert.equal(registry.configFiles[0].status, 'loaded')
    assert.match(registry.configFiles[0].sha256, /^[a-f0-9]{64}$/u)
    assert.equal(registry.sharedRoots.length, 1)
    assert.equal(registry.sharedRoots[0].references[0].group, 'shared')
    assert.equal(registry.sharedRoots[0].portable, false)
    assert.ok(registry.warnings.some(({ code }) => code === 'RUNTIME_REGISTRY_ABSOLUTE_SHARED_ROOT'))
    const candidates = registeredArtifactCandidates({ relativePath: 'models/diffusion_models/model.safetensors' }, registry)
    assert.equal(candidates.length, 2)
    assert.equal(candidates[1].targetPath, join(workspace.sharedRoot, 'models', 'diffusion_models', 'model.safetensors'))
  } finally {
    await rm(workspace.root, { recursive: true, force: true })
  }
})

test('workflow catalog reuses and verifies a shared artifact without downloading it', async () => {
  const workspace = await temporaryRuntime()
  const payload = Buffer.from('shared deterministic model')
  const { createHash } = await import('node:crypto')
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const sharedModels = join(workspace.sharedRoot, 'models', 'test')
  const pack = {
    id: 'shared-fixture',
    version: '1.0.0',
    category: 'test',
    title: 'Shared fixture',
    summary: 'Shared runtime registry fixture',
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
    artifacts: [{
      id: 'shared-model',
      kind: 'model',
      label: 'Shared model',
      relativePath: 'models/test/payload.bin',
      bytes: payload.length,
      sha256,
      downloadUrl: 'https://example.com/never-download.bin',
      sourceUrl: 'https://example.com/model',
      licenseId: 'fixture-license',
    }],
    requiredNodes: ['FixtureNode'],
    sourceUrl: 'https://example.com',
  }
  const service = new WorkflowCenterService({
    rootDirectory: workspace.stateRoot,
    getRuntimeConfig: () => ({ comfyRoot: workspace.comfyRoot, comfyArgs: [] }),
    packs: [pack],
    fetchImpl: async () => { throw new Error('shared artifact must not be downloaded') },
  })
  try {
    await mkdir(sharedModels, { recursive: true })
    await writeFile(join(sharedModels, 'payload.bin'), payload)
    await writeFile(join(workspace.comfyRoot, 'extra_model_paths.yaml'), `shared:\n  base_path: ${portablePath(workspace.sharedRoot)}\n  test: models/test\n`, 'utf8')
    await service.open()
    const installed = await service.catalog({ runtime: { connected: false, lifecycle: { state: 'stopped' } } })
    assert.equal(installed.packs[0].installed, true)
    assert.equal(installed.packs[0].downloadBytes, 0)
    assert.equal(installed.packs[0].status, 'installed-disabled')
    assert.equal(installed.packs[0].artifacts[0].location.shared, true)
    assert.doesNotMatch(JSON.stringify(installed), /[A-Z]:\\\\|\\\\Users\\\\|"targetPath"|"rootPath"/iu)
    const queued = await service.startInstall(pack.id, { acceptedLicenseIds: [], acknowledgedDiskBytes: 0 })
    const started = Date.now()
    while (!['completed', 'failed'].includes(service.job(queued.id)?.status) && Date.now() - started < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(service.job(queued.id).status, 'completed')
    const sleeping = await service.catalog({ runtime: { connected: false, lifecycle: { state: 'stopped' } } })
    assert.equal(sleeping.packs[0].status, 'enabled-sleeping')
    assert.equal(sleeping.packs[0].artifacts[0].verified, true)
    assert.equal(sleeping.packs[0].artifacts[0].contentHash, sha256)
    const waking = await service.catalog({ runtime: { connected: false, lifecycle: { state: 'starting' } } })
    assert.equal(waking.packs[0].status, 'waking')
    const executable = await service.catalog({
      runtime: { connected: true, comfyVersion: '0.31.0', lifecycle: { state: 'external' } },
      objectInfo: { FixtureNode: {} },
    })
    assert.equal(executable.packs[0].status, 'executable')
    assert.equal(executable.packs[0].ready, true)
  } finally {
    await service.close()
    await rm(workspace.root, { recursive: true, force: true })
  }
})

test('malformed extra model YAML is isolated as a registry warning', async () => {
  const workspace = await temporaryRuntime()
  try {
    await writeFile(join(workspace.comfyRoot, 'extra_model_paths.yaml'), 'broken: [unterminated', 'utf8')
    const registry = await discoverRuntimeRegistry({ comfyRoot: workspace.comfyRoot, modelCategories: ['vae'] })
    assert.equal(registry.configFiles[0].status, 'invalid')
    assert.ok(registry.warnings.some(({ code }) => code === 'RUNTIME_REGISTRY_YAML_INVALID'))
    assert.equal(registry.modelRoots.filter(({ source }) => source === 'configured-runtime').length, 1)
  } finally {
    await rm(workspace.root, { recursive: true, force: true })
  }
})
