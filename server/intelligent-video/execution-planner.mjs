import {
  assertVideoExecutionSelectionRequest,
  compileConfirmedVideoRequests,
  createVideoExecutionChecklist,
} from '../../src/lib/story/storyExecution.mjs'

export const INTELLIGENT_VIDEO_EXECUTION_MAX_BYTES = 256 * 1024

export function validateLlmExecutionSelection(candidate) {
  let value = candidate
  if (typeof candidate === 'string') {
    if (Buffer.byteLength(candidate, 'utf8') > INTELLIGENT_VIDEO_EXECUTION_MAX_BYTES) {
      throw new RangeError(`Intelligent video execution candidate exceeds ${INTELLIGENT_VIDEO_EXECUTION_MAX_BYTES} bytes`)
    }
    try {
      value = JSON.parse(candidate)
    } catch (error) {
      throw Object.assign(new TypeError('Intelligent video execution candidate is not valid JSON'), {
        code: 'INVALID_JSON',
        cause: error,
      })
    }
  }
  return assertVideoExecutionSelectionRequest(structuredClone(value))
}

export function compileControlledExecutionChecklist({ project, plan, selection, runtime, assets, now }) {
  return createVideoExecutionChecklist(
    project,
    plan,
    validateLlmExecutionSelection(selection),
    { runtime, assets, now },
  )
}

export function compileControlledH3Submissions({ checklist, confirmation, assetPayloads }) {
  return compileConfirmedVideoRequests(checklist, confirmation, assetPayloads)
}
