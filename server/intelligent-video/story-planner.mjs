import {
  assertGenerationPlan,
  compileStoryProject,
  createGenerationPlan,
  parseStoryProjectCandidate,
} from '../../src/lib/story/storyProject.mjs'

export const INTELLIGENT_VIDEO_REQUEST_SCHEMA_VERSION = 1
export const INTELLIGENT_VIDEO_REQUEST_MAX_BYTES = 128 * 1024

const REQUEST_KEYS = new Set([
  'schemaVersion', 'projectId', 'title', 'kind', 'text', 'aspectRatio', 'frameStrategy',
  'defaultShotSeconds', 'seed',
])

function assertRequestObject(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Intelligent video request must be an object')
  }
  const encodedBytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  if (encodedBytes > INTELLIGENT_VIDEO_REQUEST_MAX_BYTES) {
    throw new RangeError(`Intelligent video request exceeds ${INTELLIGENT_VIDEO_REQUEST_MAX_BYTES} bytes`)
  }
  const unknown = Object.keys(request).filter((key) => !REQUEST_KEYS.has(key))
  if (unknown.length) {
    throw new TypeError(`Intelligent video request contains unsupported fields: ${unknown.join(', ')}`)
  }
  if (request.schemaVersion !== INTELLIGENT_VIDEO_REQUEST_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported intelligent video request schema: ${request.schemaVersion}`)
  }
}

export function compileIntelligentVideoRequest(request, options = {}) {
  assertRequestObject(request)
  const now = options.now ?? Date.now()
  const project = compileStoryProject({
    projectId: request.projectId,
    title: request.title,
    kind: request.kind,
    text: request.text,
    aspectRatio: request.aspectRatio,
    frameStrategy: request.frameStrategy,
    defaultShotSeconds: request.defaultShotSeconds,
    seed: request.seed,
    now,
  })
  const plan = createGenerationPlan(project, { now })
  return {
    schemaVersion: INTELLIGENT_VIDEO_REQUEST_SCHEMA_VERSION,
    executionMode: 'plan-only',
    project,
    plan,
  }
}

export function validateLlmStoryOutput(candidate) {
  return parseStoryProjectCandidate(candidate)
}

export function validateGenerationPlanForExecution(plan, project) {
  return assertGenerationPlan(plan, project)
}
