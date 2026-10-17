import type { CanvasElement } from '../types'
export function canvasLogicalAssetId(element: Pick<CanvasElement, 'id' | 'assetId'>): string

export function observeCanvasAssetVersions(projectId: string, versions: ReadonlyArray<{ logicalAssetId: string; version: number }>): void
export function reserveCanvasAssetVersion(projectId: string, logicalAssetId: string, currentVersion?: number): number
