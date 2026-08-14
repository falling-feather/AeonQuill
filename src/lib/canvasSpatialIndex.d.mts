import type { Camera, CanvasElement } from '../types'

export type WorldBounds = { left: number; top: number; right: number; bottom: number }
export type CanvasSpatialIndex = {
  cellSize: number
  cells: Map<string, Set<string>>
  boundsById: Map<string, WorldBounds>
  globalIds: Set<string>
  allIds: string[]
}

export function elementWorldBounds(element: CanvasElement): WorldBounds
export function viewportWorldBounds(
  camera: Camera,
  viewportSize: { width: number; height: number },
  overscanScreenPixels?: number,
): WorldBounds
export function boundsIntersect(a: WorldBounds, b: WorldBounds): boolean
export function createCanvasSpatialIndex(elements: CanvasElement[], cellSize?: number): CanvasSpatialIndex
export function queryCanvasSpatialIndex(index: CanvasSpatialIndex, bounds: WorldBounds): Set<string>
