import { seedCamera } from '../data/canvasDefaults'
import { createCanvasDocument } from './canvasCore'
import { createPixelDocument, serializePixelDocument } from './pixel'
import type { ProjectModeDocument, WorkspaceProject } from './project'
import type { WorkspaceModeDocument } from './projectApi'
import { serializeSmartVideoDocument } from './story/smartVideoDocument'
import {
  createSmartVideoPreviewPlan,
  SMART_VIDEO_STARTER_SCRIPT,
} from './story/starterStory'

export type InitialWorkspaceModeDocument = Pick<
  WorkspaceModeDocument,
  'projectId' | 'documentId' | 'modeId' | 'revision' | 'value'
>

export function createInitialWorkspaceModeDocument(
  project: WorkspaceProject,
  document: ProjectModeDocument,
): InitialWorkspaceModeDocument {
  if (document.revision !== 0) {
    throw new Error(`初始正文要求目录 revision 0，当前为 ${document.revision}`)
  }
  if (document.modeId === 'balanced') {
    const canvas = createCanvasDocument({
      id: document.id,
      title: document.title,
      elements: [],
      camera: seedCamera,
      now: document.createdAt,
    })
    return {
      projectId: project.id,
      documentId: document.id,
      modeId: document.modeId,
      revision: 0,
      value: JSON.stringify(canvas),
    }
  }
  if (document.modeId === 'pixel') {
    const pixel = createPixelDocument({
      id: document.id,
      name: document.title,
      width: 16,
      height: 16,
      revision: 0,
    })
    return {
      projectId: project.id,
      documentId: document.id,
      modeId: document.modeId,
      revision: 0,
      value: serializePixelDocument(pixel),
    }
  }
  const video = createSmartVideoPreviewPlan(
    SMART_VIDEO_STARTER_SCRIPT,
    'script',
    '16:9',
    'start-end',
    document.id,
    project.title,
    undefined,
    document.createdAt,
  )
  return {
    projectId: project.id,
    documentId: document.id,
    modeId: document.modeId,
    revision: 0,
    value: serializeSmartVideoDocument(video),
  }
}
