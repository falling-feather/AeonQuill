import { MEDIA_RUN_KINDS } from './mediaSupervisor.mjs'

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export async function mediaJobFingerprint(kind, input) {
  if (!MEDIA_RUN_KINDS.includes(kind) || !input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('媒体任务指纹需要有效种类与请求')
  }
  const request = JSON.parse(JSON.stringify(input))
  delete request.mediaBinding
  // Recording/attaching the proposal advances the production revision. The
  // normal job validator still checks that current revision at submission.
  delete request.productionRevision
  if (request.candidateBinding && typeof request.candidateBinding === 'object') {
    delete request.candidateBinding.productionRevision
    delete request.candidateBinding.submissionId
  }
  if (Array.isArray(request.shots)) {
    for (const shot of request.shots) {
      if (shot?.candidateTarget && typeof shot.candidateTarget === 'object') delete shot.candidateTarget.productionRevision
    }
  }
  const bytes = new TextEncoder().encode(canonical({ kind, request }))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
