export type ProjectModeId = 'balanced' | 'pixel' | 'smart-video'
export type ProjectStatus = 'active' | 'archived' | 'trashed'
export type ProjectColorId = 'ink' | 'amber' | 'sage' | 'blue' | 'violet' | 'rose'

export interface ProjectModeDocument {
  id: string
  modeId: ProjectModeId
  title: string
  revision: number
  createdAt: number
  updatedAt: number
}

export interface WorkspaceProject {
  id: string
  title: string
  description: string
  color: ProjectColorId
  initialModeId: ProjectModeId
  status: ProjectStatus
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  trashedAt: number | null
  documents: ProjectModeDocument[]
}

export interface ProjectCatalog {
  schemaVersion: 1
  revision: number
  projects: WorkspaceProject[]
}

export class ProjectCatalogError extends Error {
  code: string
  details?: unknown
}

export const PROJECT_CATALOG_SCHEMA_VERSION: 1
export const PROJECT_TRASH_RETENTION_DAYS: 15
export const PROJECT_MODE_IDS: readonly ProjectModeId[]
export const PROJECT_STATUS_IDS: readonly ProjectStatus[]
export const PROJECT_COLOR_IDS: readonly ProjectColorId[]

export function assertProjectCatalog(input: unknown): ProjectCatalog
export function createProjectCatalog(): ProjectCatalog
export function createWorkspaceProject(
  catalog: ProjectCatalog,
  input: { title: string; description?: string; color?: ProjectColorId; initialModeId?: ProjectModeId; documentTitle?: string },
  options?: { now?: number; projectId?: string; documentId?: string },
): { catalog: ProjectCatalog; project: WorkspaceProject; document: ProjectModeDocument }
export function addProjectDocument(
  catalog: ProjectCatalog,
  projectId: string,
  input: { modeId: ProjectModeId; title?: string },
  options?: { now?: number; documentId?: string },
): { catalog: ProjectCatalog; project: WorkspaceProject; document: ProjectModeDocument }
export function touchProjectDocument(
  catalog: ProjectCatalog,
  projectId: string,
  documentId: string,
  input?: { title?: string; projectTitle?: string; revision?: number },
  options?: { now?: number },
): ProjectCatalog
export function setProjectStatus(catalog: ProjectCatalog, projectId: string, status: ProjectStatus, options?: { now?: number }): ProjectCatalog
export function openWorkspaceProject(catalog: ProjectCatalog, projectId: string, options?: { now?: number }): ProjectCatalog
export function purgeExpiredProjects(catalog: ProjectCatalog, options?: { now?: number; retentionDays?: number }): ProjectCatalog
export function projectModeDocument(project: WorkspaceProject, modeId: ProjectModeId): ProjectModeDocument | null
export function serializeProjectCatalog(catalog: ProjectCatalog): string
export function deserializeProjectCatalog(serialized: string | null | undefined): ProjectCatalog
