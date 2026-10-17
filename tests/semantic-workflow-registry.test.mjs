import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  evaluateSemanticWorkflowCatalog,
  probeLocalSemanticCapabilities,
  probeSemanticWorkflowCatalog,
  SEMANTIC_ELEMENT_EXTRACT_OPERATION,
  SEMANTIC_POINT_EDIT_OPERATION,
  SEMANTIC_PORTRAIT_ADJUST_OPERATION,
  SEMANTIC_REGION_EDIT_OPERATION,
  semanticWorkflowDefinitions,
  validateElementExtractRequest,
  validateSemanticImageRequest,
} from '../server/semantic-workflow-registry.mjs'
import { discoverRuntimeRegistry } from '../server/runtime-registry.mjs'

const sourceImageDataUrl = 'data:image/png;base64,AAAA'
const maskImageDataUrl = 'data:image/png;base64,AQID'

function portablePath(pathname) {
  return pathname.replace(/\\/gu, '/')
}

async function semanticSharedFixture() {
  const root = await mkdtemp(join(process.cwd(), '.runtime', 'test-temp', 'semantic-shared-roots-'))
  const comfyRoot = join(root, 'main', 'ComfyUI')
  const sharedRoot = join(root, 'shared', 'ComfyUI')
  await Promise.all([
    mkdir(join(comfyRoot, 'custom_nodes', 'ComfyUI-Impact-Pack'), { recursive: true }),
    mkdir(join(sharedRoot, 'models', 'sams'), { recursive: true }),
  ])
  const samPath = join(sharedRoot, 'models', 'sams', 'sam_vit_b_01ec64.pth')
  await writeFile(samPath, Buffer.alloc(0))
  await truncate(samPath, 375_042_383)
  await writeFile(join(comfyRoot, 'extra_model_paths.yaml'), [
    'shared:',
    `  base_path: ${portablePath(sharedRoot)}`,
    '  sams: models/sams',
    '',
  ].join('\n'), 'utf8')
  return { root, comfyRoot, sharedRoot, samPath }
}

test('semantic workflow catalog exposes four stable, unique workflows', () => {
  const definitions = semanticWorkflowDefinitions()
  assert.deepEqual(definitions.map((item) => item.id), [
    'element-extract',
    'region-edit',
    'point-edit',
    'portrait-adjust',
  ])
  assert.equal(new Set(definitions.map((item) => item.id)).size, definitions.length)
  for (const workflow of definitions) {
    assert.ok(workflow.version)
    assert.ok(workflow.allowedNodeTypes.length > 0)
    assert.ok(workflow.outputs.length > 0)
    assert.ok(['gpu', 'cpu'].includes(workflow.resources.class))
  }
})

test('element extraction reports installed but stopped separately from ready', () => {
  const local = {
    extensions: new Set(['impact-pack']),
    artifacts: new Set(['sam-vit-b']),
  }
  const stopped = evaluateSemanticWorkflowCatalog(local)
  const stoppedWorkflow = stopped.workflows.find((item) => item.id === 'element-extract')
  assert.equal(stoppedWorkflow.installed, true)
  assert.equal(stoppedWorkflow.available, false)
  assert.equal(stoppedWorkflow.status, 'runtime-stopped')

  const ready = evaluateSemanticWorkflowCatalog({
    ...local,
    objectInfo: { SAMLoader: {}, LoadImage: {}, MaskToImage: {}, SaveImage: {} },
    runtime: { connected: true, device: 'test-gpu', vramTotal: 8 * 1024 ** 3 },
  })
  const readyWorkflow = ready.workflows.find((item) => item.id === 'element-extract')
  assert.equal(readyWorkflow.available, true)
  assert.equal(readyWorkflow.status, 'ready')
  assert.deepEqual(readyWorkflow.missingNodes, [])
})

test('semantic catalog reports missing dependencies and node mismatches without paths', () => {
  const missing = evaluateSemanticWorkflowCatalog({ objectInfo: {}, runtime: { connected: true } })
  const elementExtract = missing.workflows.find((item) => item.id === 'element-extract')
  assert.equal(elementExtract.status, 'missing-dependency')
  assert.deepEqual(elementExtract.missingExtensions, ['impact-pack'])
  assert.deepEqual(elementExtract.missingArtifacts, ['sam-vit-b'])
  assert.deepEqual(elementExtract.missingNodes, ['SAMLoader'])
  assert.equal(JSON.stringify(missing).includes('models/'), false)

  const nodeMismatch = evaluateSemanticWorkflowCatalog({
    extensions: ['impact-pack'],
    artifacts: ['sam-vit-b'],
    objectInfo: { LoadImage: {} },
    runtime: { connected: true },
  }).workflows.find((item) => item.id === 'element-extract')
  assert.equal(nodeMismatch.status, 'node-mismatch')
  assert.deepEqual(nodeMismatch.missingNodes, ['SAMLoader'])
})

test('all four workflows become ready when their exact dependencies and nodes are present', () => {
  const allDefinitions = semanticWorkflowDefinitions()
  const extensions = new Set(allDefinitions.flatMap((item) => item.requiredExtensions))
  const artifacts = new Set(allDefinitions.flatMap((item) => item.requiredArtifacts))
  const objectInfo = Object.fromEntries(allDefinitions.flatMap((item) => item.requiredNodes).map((id) => [id, {}]))
  const catalog = evaluateSemanticWorkflowCatalog({ extensions, artifacts, objectInfo, runtime: { connected: true } })
  for (const workflow of catalog.workflows) {
    assert.equal(workflow.available, true, workflow.id)
    assert.equal(workflow.status, 'ready')
  }
})

test('element extraction request is normalized into a strict stored request', () => {
  const request = validateElementExtractRequest({
    workflowId: 'element-extract',
    sourceImageDataUrl,
    sourceElementId: 'source-1',
    params: {
      positivePoints: [{ x: 0.25, y: 0.75 }],
      negativePoints: [{ x: 0, y: 1 }],
    },
  })
  assert.equal(request.operation, SEMANTIC_ELEMENT_EXTRACT_OPERATION)
  assert.equal(request.workflowVersion, 'impact-sam-v1')
  assert.equal(request.params.threshold, 0.9)
  assert.equal('sourceImageDataUrl' in request, false)
})

test('element extraction rejects unknown fields, missing positives, bad coordinates, and thresholds', () => {
  assert.throws(
    () => validateElementExtractRequest({ workflowId: 'element-extract', sourceImageDataUrl, params: {}, surprise: true }),
    /unsupported field/,
  )
  assert.throws(
    () => validateElementExtractRequest({ workflowId: 'element-extract', sourceImageDataUrl, params: {} }),
    /at least one positive point/u,
  )
  assert.throws(
    () => validateElementExtractRequest({
      workflowId: 'element-extract',
      sourceImageDataUrl,
      params: { positivePoints: [{ x: 1.1, y: 0.5 }] },
    }),
    /normalized coordinates/,
  )
  assert.throws(
    () => validateElementExtractRequest({
      workflowId: 'element-extract',
      sourceImageDataUrl,
      params: { positivePoints: [{ x: 0.5, y: 0.5 }], threshold: 0.1 },
    }),
    /threshold/,
  )
})

test('region, point and portrait requests normalize into strict stored contracts without data URLs', () => {
  const region = validateSemanticImageRequest({
    workflowId: 'region-edit',
    projectId: 'project-semantic',
    sourceImageDataUrl,
    maskImageDataUrl,
    sourceElementId: 'source-1',
    title: '蓝色服饰版本',
    params: { instruction: '把衣服改为深蓝色', seed: 12, maskChannel: 'alpha' },
  })
  assert.equal(region.operation, SEMANTIC_REGION_EDIT_OPERATION)
  assert.equal(region.params.seed, 12)
  assert.equal('sourceImageDataUrl' in region, false)
  assert.equal('maskImageDataUrl' in region, false)

  const point = validateSemanticImageRequest({
    workflowId: 'point-edit',
    projectId: 'project-semantic',
    sourceAssetId: 'a'.repeat(64),
    params: {
      instruction: '把手中的花改为灯笼',
      positivePoints: [{ x: 0.5, y: 0.5 }],
      negativePoints: [],
    },
  })
  assert.equal(point.operation, SEMANTIC_POINT_EDIT_OPERATION)
  assert.equal(point.sourceAssetId, 'a'.repeat(64))
  assert.equal(point.params.threshold, 0.9)

  const portrait = validateSemanticImageRequest({
    workflowId: 'portrait-adjust',
    projectId: 'project-semantic',
    sourceImageDataUrl,
    params: { instruction: '让人物自然微笑', identityStrength: 0.9 },
  })
  assert.equal(portrait.operation, SEMANTIC_PORTRAIT_ADJUST_OPERATION)
  assert.equal(portrait.params.identityStrength, 0.9)
})

test('Qwen image requests accept lightning4 and retain base40 compatibility', () => {
  const base = validateSemanticImageRequest({
    workflowId: 'region-edit',
    projectId: 'project-semantic',
    sourceImageDataUrl,
    maskImageDataUrl,
    params: { instruction: '修改颜色', preset: 'base40' },
  })
  assert.equal(base.workflowVersion, 'qwen-image-edit-2511-int8-v1')
  assert.equal('preset' in base.params, false)

  const lightning = validateSemanticImageRequest({
    workflowId: 'region-edit',
    projectId: 'project-semantic',
    sourceImageDataUrl,
    maskImageDataUrl,
    params: { instruction: '修改颜色', preset: 'lightning4' },
  })
  assert.equal(lightning.workflowVersion, 'qwen-image-edit-2511-int8-lightning4-v1')
  assert.equal(lightning.params.preset, 'lightning4')

  assert.throws(
    () => validateSemanticImageRequest({
      workflowId: 'element-extract',
      sourceImageDataUrl,
      params: { positivePoints: [{ x: 0.5, y: 0.5 }], preset: 'lightning4' },
    }),
    /unsupported field/u,
  )
  assert.throws(
    () => validateSemanticImageRequest({
      workflowId: 'portrait-adjust',
      projectId: 'project-semantic',
      sourceImageDataUrl,
      params: { instruction: '调整', preset: 'unknown' },
    }),
    (error) => error.code === 'INVALID_IMAGE_EDIT_PRESET',
  )
})

test('Qwen catalog exposes installed and runtime status for base40 and lightning4 presets', () => {
  const definitions = semanticWorkflowDefinitions()
  const required = new Set(definitions.flatMap((item) => item.requiredArtifacts))
  const extensions = new Set(definitions.flatMap((item) => item.requiredExtensions))
  const objectInfo = Object.fromEntries(definitions.flatMap((item) => item.requiredNodes).map((id) => [id, {}]))
  const catalog = evaluateSemanticWorkflowCatalog({
    extensions,
    artifacts: [...required, 'qwen-image-edit-2511-lightning4-bf16-v1'],
    objectInfo: { ...objectInfo, LoraLoaderModelOnly: {} },
    runtime: { connected: true },
  })
  for (const id of ['region-edit', 'point-edit', 'portrait-adjust']) {
    const workflow = catalog.workflows.find((item) => item.id === id)
    assert.deepEqual(workflow.presets.map(({ id: presetId }) => presetId), ['base40', 'lightning4'])
    assert.equal(workflow.presets.every(({ installed }) => installed), true)
    assert.equal(workflow.presets.every(({ status }) => status === 'ready'), true)
    assert.equal(workflow.presets.every(({ available }) => available), true)
  }

  const missing = evaluateSemanticWorkflowCatalog({
    artifacts: [...required],
    objectInfo,
    runtime: { connected: true },
  })
  const lightning = missing.workflows.find((item) => item.id === 'region-edit').presets.find(({ id }) => id === 'lightning4')
  assert.equal(lightning.installed, false)
  assert.equal(lightning.available, false)
  assert.equal(lightning.status, 'missing-dependency')
  assert.deepEqual(lightning.missingArtifacts, ['qwen-image-edit-2511-lightning4-bf16-v1'])
  assert.deepEqual(lightning.missingNodes, ['LoraLoaderModelOnly'])
})

test('generative semantic requests reject invalid masks, parameters and ambiguous sources', () => {
  assert.throws(
    () => validateSemanticImageRequest({
      workflowId: 'region-edit', projectId: 'project-semantic', sourceImageDataUrl,
      params: { instruction: '修改颜色' },
    }),
    (error) => error.code === 'INVALID_SEMANTIC_INPUT',
  )
  assert.throws(
    () => validateSemanticImageRequest({
      workflowId: 'region-edit', projectId: 'project-semantic', sourceImageDataUrl,
      sourceAssetId: 'a'.repeat(64), maskImageDataUrl,
      params: { instruction: '修改颜色' },
    }),
    (error) => error.code === 'INVALID_SEMANTIC_INPUT',
  )
  assert.throws(
    () => validateSemanticImageRequest({
      workflowId: 'portrait-adjust', projectId: 'project-semantic', sourceImageDataUrl,
      params: { instruction: '修改', identityStrength: 1.1 },
    }),
    (error) => error.code === 'INVALID_SEMANTIC_IDENTITY_STRENGTH',
  )
  assert.throws(
    () => validateSemanticImageRequest({
      workflowId: 'point-edit', projectId: 'project-semantic', sourceImageDataUrl,
      params: { instruction: '修改', positivePoints: [{ x: 0.5, y: 0.5 }], seed: -1 },
    }),
    (error) => error.code === 'INVALID_SEMANTIC_SEED',
  )
})

test('semantic capability probing resolves registered shared model roots and preserves stopped/node gates', async () => {
  const fixture = await semanticSharedFixture()
  try {
    const registry = await discoverRuntimeRegistry({ comfyRoot: fixture.comfyRoot, modelCategories: ['custom_nodes', 'sams'] })
    const local = await probeLocalSemanticCapabilities(fixture.comfyRoot, { runtimeRegistry: registry })
    assert.equal(local.artifacts.has('sam-vit-b'), true)
    assert.equal(local.extensions.has('impact-pack'), true)

    const stopped = await probeSemanticWorkflowCatalog({
      comfyRoot: join(fixture.root, 'main', 'missing-comfy-root'),
      runtimeRegistry: registry,
      runtime: { connected: false, lifecycle: { state: 'stopped' } },
    })
    const stoppedWorkflow = stopped.workflows.find((item) => item.id === 'element-extract')
    assert.equal(stoppedWorkflow.installed, true)
    assert.equal(stoppedWorkflow.available, false)
    assert.equal(stoppedWorkflow.status, 'runtime-stopped')

    const connected = await probeSemanticWorkflowCatalog({
      comfyRoot: fixture.comfyRoot,
      runtimeRegistry: registry,
      objectInfo: { LoadImage: {}, MaskToImage: {}, SaveImage: {} },
      runtime: { connected: true, lifecycle: { state: 'external' } },
    })
    const nodeMismatch = connected.workflows.find((item) => item.id === 'element-extract')
    assert.equal(nodeMismatch.installed, true)
    assert.equal(nodeMismatch.available, false)
    assert.equal(nodeMismatch.status, 'node-mismatch')
    assert.deepEqual(nodeMismatch.missingNodes, ['SAMLoader'])
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('semantic probing does not match same-named artifacts in unregistered roots or malformed roots', async () => {
  const root = await mkdtemp(join(process.cwd(), '.runtime', 'test-temp', 'semantic-shared-roots-unregistered-'))
  try {
    const comfyRoot = join(root, 'main', 'ComfyUI')
    const unregisteredRoot = join(root, 'unregistered', 'ComfyUI', 'models', 'sams')
    await mkdir(join(comfyRoot, 'custom_nodes', 'ComfyUI-Impact-Pack'), { recursive: true })
    await mkdir(unregisteredRoot, { recursive: true })
    const unregisteredSam = join(unregisteredRoot, 'sam_vit_b_01ec64.pth')
    await writeFile(unregisteredSam, Buffer.alloc(0))
    await truncate(unregisteredSam, 375_042_383)
    const registry = await discoverRuntimeRegistry({ comfyRoot, modelCategories: ['custom_nodes', 'sams'] })
    const unregistered = await probeLocalSemanticCapabilities(comfyRoot, { runtimeRegistry: registry })
    assert.equal(unregistered.extensions.has('impact-pack'), true)
    assert.equal(unregistered.artifacts.has('sam-vit-b'), false)

    const malformedRoot = join(root, 'malformed', 'ComfyUI')
    const malformedShared = join(root, 'malformed-shared', 'ComfyUI', 'models', 'sams')
    await mkdir(join(malformedRoot, 'custom_nodes', 'ComfyUI-Impact-Pack'), { recursive: true })
    await mkdir(malformedShared, { recursive: true })
    const malformedSam = join(malformedShared, 'sam_vit_b_01ec64.pth')
    await writeFile(malformedSam, Buffer.alloc(0))
    await truncate(malformedSam, 375_042_383)
    await writeFile(join(malformedRoot, 'extra_model_paths.yaml'), 'shared: [unterminated', 'utf8')
    const malformedRegistry = await discoverRuntimeRegistry({ comfyRoot: malformedRoot, modelCategories: ['custom_nodes', 'sams'] })
    assert.equal(malformedRegistry.configFiles[0].status, 'invalid')
    const malformed = await probeLocalSemanticCapabilities(malformedRoot, { runtimeRegistry: malformedRegistry })
    assert.equal(malformed.extensions.has('impact-pack'), true)
    assert.equal(malformed.artifacts.has('sam-vit-b'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('semantic probing keeps empty and missing-root behavior fail-closed', async () => {
  const empty = await probeLocalSemanticCapabilities(undefined)
  assert.deepEqual([...empty.extensions], [])
  assert.deepEqual([...empty.artifacts], [])
  const missing = await probeLocalSemanticCapabilities(join(process.cwd(), '.runtime', 'test-temp', 'semantic-root-does-not-exist'))
  assert.deepEqual([...missing.extensions], [])
  assert.deepEqual([...missing.artifacts], [])
})
