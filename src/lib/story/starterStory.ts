import {
  compileStoryProject,
  createGenerationPlan,
  type FrameStrategy,
  type GenerationPlan,
  type StoryAspectRatio,
  type StoryProject,
  type StorySourceKind,
} from './storyProject.mjs'
import {
  createVideoProductionProjectForStory,
  synchronizeVideoProductionProjectForStory,
  type VideoProductionProject,
} from './productionPipeline.mjs'

export const SMART_VIDEO_STARTER_SCRIPT = `场景 1：雨夜·旧城书店
镜头 1：全景，雨水沿着老街招牌落下，阿砚推开书店木门。
阿砚：我只想找回被遗忘的那一页。
镜头 2：缓慢推进到柜台，店主把一枚发光的墨锭推到灯下。
店主：写下名字，时间就会替你翻页。

场景 2：黎明·河岸
镜头 1：中景跟拍，阿砚沿河岸奔跑，手中墨锭映出不断变化的旧照片。
镜头 2：特写，阿砚停下，把墨锭按在空白纸面，晨光从纸上铺开。`

export type SmartVideoPlanResult = {
  project: StoryProject
  plan: GenerationPlan
  production: VideoProductionProject
}

export function createSmartVideoPreviewPlan(
  text: string,
  kind: StorySourceKind,
  aspectRatio: StoryAspectRatio,
  frameStrategy: FrameStrategy,
  projectId?: string,
  projectTitle?: string,
  production?: VideoProductionProject,
  now = Date.now(),
): SmartVideoPlanResult {
  const project = compileStoryProject({
    kind,
    text,
    projectId,
    title: projectTitle,
    aspectRatio,
    frameStrategy,
    defaultShotSeconds: 5,
    now,
  })
  return {
    project,
    plan: createGenerationPlan(project, { now }),
    production: production
      ? synchronizeVideoProductionProjectForStory(production, project, { now })
      : createVideoProductionProjectForStory(project, { now }),
  }
}
