import type { CanvasElement } from '../types'

export const CANVAS_ALIGNMENT_WIDTH: 1200
export const CANVAS_ALIGNMENT_HEIGHT: 800

export type CanvasAlignment = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom'

export type CanvasAlignmentUpdate = {
  id: string
  patch: {
    x?: number
    y?: number
  }
}

export function createCanvasAlignmentUpdates(
  elements: CanvasElement[],
  selectedIds: string[],
  alignment: CanvasAlignment,
): CanvasAlignmentUpdate[]

export function createCanvasConnection(
  elements: CanvasElement[],
  input: { id: string; fromId: string; toId: string },
): CanvasElement

export function canvasConnectorPorts(
  from: CanvasElement,
  to: CanvasElement,
): { x1: number; y1: number; x2: number; y2: number }
