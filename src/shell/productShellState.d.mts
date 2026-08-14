import type { ProductModeId } from './modeRegistry'

export const PRODUCT_SHELL_PREFERENCES_KEY: 'aeonquill:product-shell:v1'
export const SMART_VIDEO_SESSION_KEY: 'aeonquill:smart-video-session:v1'
export const DEFAULT_BALANCED_PROJECT_ID: 'local-project'

export type ProductLocation = {
  modeId: 'home' | ProductModeId
  projectId?: string
  canonical: boolean
}

export type ShellPreferences = {
  version: 1
  selectedModeId: ProductModeId
  balancedProjectId: string
}

export type SmartVideoSessionSummary = {
  version: 1
  projectId: string
  title: string
  sourceKind: 'idea' | 'script'
  sourceText: string
  updatedAt: number
  sceneCount: number
  taskCount: number
}

export type CollectionState = 'loading' | 'empty' | 'error' | 'recovered' | 'ready'

export function isProductModeId(value: unknown): value is ProductModeId
export function normalizeProjectReference(value: unknown): string | undefined
export function parseProductHash(hash: unknown): ProductLocation
export function createProductTarget(
  pathname: string,
  search: string,
  location: { modeId: 'home' | ProductModeId; projectId?: string },
): string
export function parseShellPreferences(rawValue: unknown): ShellPreferences
export function serializeShellPreferences(preferences: Partial<ShellPreferences>): string
export function parseSmartVideoSession(rawValue: unknown): SmartVideoSessionSummary | null
export function serializeSmartVideoSession(session: SmartVideoSessionSummary): string
export function resolveCollectionState(input: {
  loading: boolean
  error: boolean
  itemCount: number
  recoveredCount: number
}): CollectionState
export function resolvePixelDraftEntry(input: {
  requestedProjectId?: string
  status: 'empty' | 'ready' | 'error'
  documentId?: string
}): {
  hasMemoryDocument: boolean
  requestedDraftMissing: boolean
  unreadable: boolean
}
