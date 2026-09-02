import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateSemanticWorkflowCatalog,
  SEMANTIC_ELEMENT_EXTRACT_OPERATION,
  SEMANTIC_POINT_EDIT_OPERATION,
  SEMANTIC_PORTRAIT_ADJUST_OPERATION,
  SEMANTIC_REGION_EDIT_OPERATION,
  semanticWorkflowDefinitions,
  validateElementExtractRequest,
  validateSemanticImageRequest,
} from '../server/semantic-workflow-registry.mjs'

const sourceImageDataUrl = 'data:image/png;base64,AAAA'
const maskImageDataUrl = 'data:image/png;base64,AQID'

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
