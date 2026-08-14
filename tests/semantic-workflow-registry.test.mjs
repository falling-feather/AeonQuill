import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateSemanticWorkflowCatalog,
  SEMANTIC_ELEMENT_EXTRACT_OPERATION,
  semanticWorkflowDefinitions,
  validateElementExtractRequest,
} from '../server/semantic-workflow-registry.mjs'

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

test('non-executable workflows remain unavailable even when dependencies are present', () => {
  const allDefinitions = semanticWorkflowDefinitions()
  const extensions = new Set(allDefinitions.flatMap((item) => item.requiredExtensions))
  const artifacts = new Set(allDefinitions.flatMap((item) => item.requiredArtifacts))
  const objectInfo = Object.fromEntries(allDefinitions.flatMap((item) => item.requiredNodes).map((id) => [id, {}]))
  const catalog = evaluateSemanticWorkflowCatalog({ extensions, artifacts, objectInfo, runtime: { connected: true } })
  for (const workflow of catalog.workflows.filter((item) => item.id !== 'element-extract')) {
    assert.equal(workflow.available, false)
    assert.equal(workflow.status, 'template-pending')
  }
})

test('element extraction request is normalized into a strict stored request', () => {
  const request = validateElementExtractRequest({
    workflowId: 'element-extract',
    sourceImageDataUrl: 'data:image/png;base64,AAAA',
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
    () => validateElementExtractRequest({ workflowId: 'element-extract', params: {}, surprise: true }),
    /unsupported field/,
  )
  assert.throws(
    () => validateElementExtractRequest({ workflowId: 'element-extract', params: {} }),
    /at least one positive point/,
  )
  assert.throws(
    () => validateElementExtractRequest({
      workflowId: 'element-extract',
      params: { positivePoints: [{ x: 1.1, y: 0.5 }] },
    }),
    /normalized coordinates/,
  )
  assert.throws(
    () => validateElementExtractRequest({
      workflowId: 'element-extract',
      params: { positivePoints: [{ x: 0.5, y: 0.5 }], threshold: 0.1 },
    }),
    /threshold/,
  )
})
