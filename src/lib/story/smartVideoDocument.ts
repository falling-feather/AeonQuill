import {
  assertGenerationPlan,
  assertStoryProject,
  type GenerationPlan,
  type StoryProject,
} from './storyProject.mjs'
import {
  createVideoProductionProjectForStory,
  migrateVideoProductionProject,
  type VideoProductionProject,
} from './productionPipeline.mjs'

export const SMART_VIDEO_DOCUMENT_SCHEMA_VERSION = 2

export type SmartVideoDocument = {
  schemaVersion: typeof SMART_VIDEO_DOCUMENT_SCHEMA_VERSION
  project: StoryProject
  plan: GenerationPlan
  production: VideoProductionProject
}

export function serializeSmartVideoDocument(input: { project: StoryProject; plan: GenerationPlan; production?: VideoProductionProject }) {
  const project = assertStoryProject(input.project)
  const plan = assertGenerationPlan(input.plan, project)
  const production = input.production
    ? migrateVideoProductionProject(input.production, { story: project })
    : createVideoProductionProjectForStory(project)
  return JSON.stringify({ schemaVersion: SMART_VIDEO_DOCUMENT_SCHEMA_VERSION, project, plan, production })
}

export function deserializeSmartVideoDocument(serialized: string): SmartVideoDocument {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('智能视频项目正文不是有效 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('智能视频项目正文必须是对象')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  const isLegacy = record.schemaVersion === 1 && keys === 'plan,project,schemaVersion'
  const isCurrent = record.schemaVersion === SMART_VIDEO_DOCUMENT_SCHEMA_VERSION && keys === 'plan,production,project,schemaVersion'
  if (!isLegacy && !isCurrent) {
    throw new Error('智能视频项目正文版本或字段不受支持')
  }
  const project = assertStoryProject(record.project as StoryProject)
  const plan = assertGenerationPlan(record.plan as GenerationPlan, project)
  const production = isLegacy
    ? createVideoProductionProjectForStory(project)
    : migrateVideoProductionProject(record.production, { story: project })
  return { schemaVersion: SMART_VIDEO_DOCUMENT_SCHEMA_VERSION, project, plan, production }
}
