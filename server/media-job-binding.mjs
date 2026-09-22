import { createHash } from 'node:crypto'
import { migrateVideoProductionProject } from '../src/lib/story/productionPipeline.mjs'
import { assertCanConfirmMediaRun } from '../src/lib/story/mediaSupervisor.mjs'
import { mediaJobFingerprint } from '../src/lib/story/mediaJobBinding.mjs'

const FIELDS = ['projectId', 'documentId', 'runId', 'inputFingerprint']
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/u
function fail(code, message, status = 409) { throw Object.assign(new Error(message), { code, status }) }

export async function prepareMediaJobEnvelope(raw, kinds, { workspaceStore } = {}) {
  if (!raw || typeof raw !== 'object' || !Object.hasOwn(raw, 'mediaBinding')) return { body: raw }
  const { mediaBinding: supplied, ...body } = raw
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
    || Object.keys(supplied).some((key) => !FIELDS.includes(key)) || FIELDS.some((key) => !Object.hasOwn(supplied, key))) {
    fail('MEDIA_JOB_BINDING_INVALID', '媒体任务绑定字段无效', 400)
  }
  const mediaBinding = Object.fromEntries(FIELDS.map((key) => [key, supplied[key]]))
  for (const key of ['projectId', 'documentId', 'runId']) {
    if (typeof mediaBinding[key] !== 'string' || !ID.test(mediaBinding[key])) fail('MEDIA_JOB_BINDING_INVALID', '媒体任务身份无效', 400)
  }
  if (typeof mediaBinding.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(mediaBinding.inputFingerprint)) fail('MEDIA_JOB_BINDING_INVALID', '媒体任务缺少完整请求指纹', 400)
  const project = workspaceStore.getCatalog().catalog.projects.find(({ id }) => id === mediaBinding.projectId)
  if (!project || project.status !== 'active' || !project.documents.some((document) => document.id === mediaBinding.documentId && document.modeId === 'smart-video')) fail('MEDIA_JOB_PROJECT_MISMATCH', '媒体任务不属于当前活动项目中的智能视频文档')
  const stored = workspaceStore.getModeDocument(mediaBinding.documentId)
  if (!stored || stored.projectId !== mediaBinding.projectId || stored.modeId !== 'smart-video') fail('MEDIA_JOB_DOCUMENT_MISMATCH', '媒体文档身份不匹配')
  const production = migrateVideoProductionProject(JSON.parse(stored.value).production)
  const run = production.mediaRuns.find(({ id }) => id === mediaBinding.runId)
  if (!run || !kinds.includes(run.kind)) fail('MEDIA_JOB_KIND_MISMATCH', '媒体提议与执行器不匹配')
  try { assertCanConfirmMediaRun(production, run.id, { currentInputFingerprint: mediaBinding.inputFingerprint }) }
  catch (error) { error.status = 409; throw error }
  if ((body.projectId !== undefined && body.projectId !== mediaBinding.projectId)
    || (body.documentId !== undefined && body.documentId !== mediaBinding.documentId)) fail('MEDIA_JOB_PROJECT_MISMATCH', '媒体请求指向其他项目或文档')
  if (body.candidateBinding && (body.candidateBinding.projectId !== mediaBinding.projectId
    || body.candidateBinding.documentId !== mediaBinding.documentId
    || (run.targetId !== null && body.candidateBinding.shotId !== run.targetId))) fail('MEDIA_JOB_TARGET_MISMATCH', 'H3 候选目标与媒体提议不匹配')
  if (body.customWorkflowId && run.targetId !== body.customWorkflowId) fail('MEDIA_JOB_TARGET_MISMATCH', '素材工作流与媒体提议不匹配')
  if (body.action && body.action !== run.kind) fail('MEDIA_JOB_KIND_MISMATCH', '声音动作与媒体提议不匹配')
  if (await mediaJobFingerprint(run.kind, body) !== run.inputFingerprint) fail('MEDIA_JOB_INPUT_CHANGED', '执行参数或素材已变化，请重新提出并确认媒体任务')
  const idempotencyKey = `media-run-${createHash('sha256').update(JSON.stringify(mediaBinding)).digest('hex')}`
  return { body, mediaBinding, idempotencyKey }
}
