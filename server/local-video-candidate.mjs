import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { assertVideoProductionProject } from '../src/lib/story/productionPipeline.mjs'
import {
  assertLocalVideoCandidateJobBinding,
  createReadyLocalVideoCandidateBackfill,
} from '../src/lib/story/localVideoCandidate.mjs'

function fail(code, message, status = 409, details = undefined) {
  throw Object.assign(new Error(message), { code, status, details })
}

function candidateWorkspaceDocument(binding, workspaceStore) {
  const stored = workspaceStore.getModeDocument(binding.documentId)
  if (!stored || stored.modeId !== 'smart-video' || stored.projectId !== binding.projectId) {
    fail('LOCAL_CANDIDATE_WORKSPACE_NOT_FOUND', '本地视频候选所属的智能视频项目不存在或身份不匹配', 404)
  }
  let payload
  try {
    payload = JSON.parse(stored.value)
  } catch {
    fail('LOCAL_CANDIDATE_WORKSPACE_INVALID', '智能视频项目正文无法解析')
  }
  return { stored, production: assertVideoProductionProject(payload?.production) }
}

export function authoritativeLocalVideoCandidate(bindingInput, services, options = {}) {
  const binding = assertLocalVideoCandidateJobBinding(bindingInput)
  const { stored, production } = candidateWorkspaceDocument(binding, services.workspaceStore)
  if (production.id !== binding.productionId
    || production.continuityGraph.storyProjectId !== binding.documentId) {
    fail('LOCAL_CANDIDATE_PRODUCTION_MISMATCH', '本地视频候选与当前制片文档身份不一致')
  }
  if (options.requireProductionRevision !== false
    && (production.revision !== binding.productionRevision
      || production.continuityGraph.revision !== binding.continuityRevision)) {
    fail('LOCAL_CANDIDATE_PRODUCTION_STALE', '制片项目已变化；请等待保存完成后重新检查并提交', 409, {
      expectedProductionRevision: binding.productionRevision,
      actualProductionRevision: production.revision,
      expectedContinuityRevision: binding.continuityRevision,
      actualContinuityRevision: production.continuityGraph.revision,
    })
  }
  if (production.continuityGraph.storyRevision !== binding.storyRevision) {
    fail('LOCAL_CANDIDATE_STORY_STALE', '故事版本已变化；旧任务不能回填当前镜头')
  }
  if (production.settings.generationMode !== binding.generationMode) {
    fail('LOCAL_CANDIDATE_MODE_STALE', '制片生成策略已变化；旧任务不能回填当前镜头')
  }
  const shot = production.continuityGraph.shots.find(({ id }) => id === binding.shotId)
  if (!shot) fail('LOCAL_CANDIDATE_SHOT_NOT_FOUND', '本地视频候选目标镜头已不存在', 404)
  if (shot.status === 'blocked') fail('LOCAL_CANDIDATE_SHOT_BLOCKED', '目标镜头仍有未批准的必需资产')
  if (shot.inputFingerprint !== binding.inputFingerprint) {
    fail('LOCAL_CANDIDATE_INPUT_STALE', '镜头输入已变化；旧任务不能回填当前候选')
  }
  return { stored, production, shot, binding }
}

function validateExistingAsset(asset, expected) {
  if (!asset
    || asset.scope !== 'project'
    || asset.projectId !== expected.binding.projectId
    || asset.relationship !== 'project-owned'
    || asset.mediaKind !== 'video'
    || asset.version?.assetId !== expected.contentHash
    || asset.version?.mimeType !== 'video/mp4'
    || asset.version?.provenance?.source !== 'local-h3-video-candidate'
    || asset.version?.provenance?.jobId !== expected.job.id
    || asset.version?.provenance?.documentId !== expected.binding.documentId
    || asset.version?.provenance?.shotId !== expected.binding.shotId
    || asset.version?.provenance?.executionItemId !== expected.binding.executionItemId
    || asset.version?.provenance?.submissionId !== expected.binding.submissionId) {
    fail('LOCAL_CANDIDATE_LIBRARY_CONFLICT', '已存在的候选资源与本次任务身份或内容不一致')
  }
  return asset
}

export async function promoteLocalVideoCandidateOutput(input) {
  const job = input.job
  if (!job || job.kind !== 'video' || !job.request?.candidateBinding) {
    fail('LOCAL_CANDIDATE_JOB_INVALID', 'Only a bound single-shot H3 job can be promoted')
  }
  const authority = authoritativeLocalVideoCandidate(job.request.candidateBinding, input, {
    requireProductionRevision: false,
  })
  const bytes = await readFile(input.outputPath)
  if (!bytes.length) fail('LOCAL_CANDIDATE_OUTPUT_EMPTY', '本地 H3 视频输出为空')
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const identityHash = createHash('sha256')
    .update(`${job.id}\0${authority.binding.projectId}\0${authority.binding.documentId}\0${authority.binding.shotId}\0${authority.binding.submissionId}`, 'utf8')
    .digest('hex')
  const itemId = `library-h3-${identityHash.slice(0, 32)}`
  let libraryAsset = input.projectStore.getLibraryAsset(itemId, { projectId: authority.binding.projectId })
  if (libraryAsset) {
    libraryAsset = validateExistingAsset(libraryAsset, { job, binding: authority.binding, contentHash })
  } else {
    libraryAsset = await input.projectStore.createLibraryAsset({
      id: itemId,
      scope: 'project',
      projectId: authority.binding.projectId,
      title: `${authority.shot.label} · 本地 H3 · 第 ${job.scheduling?.attempt || 1} 次`.slice(0, 120),
      description: '由光阴砚本地 MiniMax H3 单镜头任务生成；已按不可变内容版本写入项目资源库。',
      tags: ['h3', '智能视频', '镜头候选'],
      dataUrl: `data:video/mp4;base64,${bytes.toString('base64')}`,
    }, {
      source: 'local-h3-video-candidate',
      now: input.now,
      provenance: {
        jobId: job.id,
        retryOf: job.retryOf || null,
        projectId: authority.binding.projectId,
        documentId: authority.binding.documentId,
        productionId: authority.binding.productionId,
        productionRevision: authority.binding.productionRevision,
        continuityRevision: authority.binding.continuityRevision,
        storyRevision: authority.binding.storyRevision,
        shotId: authority.binding.shotId,
        inputFingerprint: authority.binding.inputFingerprint,
        generationMode: authority.binding.generationMode,
        executionItemId: authority.binding.executionItemId,
        submissionId: authority.binding.submissionId,
        workflowVersion: job.workflowVersion,
      },
    })
    validateExistingAsset(libraryAsset, { job, binding: authority.binding, contentHash })
  }
  return {
    libraryAsset,
    localCandidateBackfill: createReadyLocalVideoCandidateBackfill({
      jobId: job.id,
      binding: authority.binding,
      libraryAsset,
      now: input.now,
    }),
  }
}
