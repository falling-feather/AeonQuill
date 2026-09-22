export type WorkflowControlRole =
  | 'seed'
  | 'width'
  | 'height'
  | 'frames'
  | 'steps'
  | 'cfg'
  | 'denoise'
  | 'loraStrength'
  | 'loraClipStrength'
  | 'controlStrength'

export type WorkflowControlField = {
  label: string
  min: number
  max: number
  step: number
  integer: boolean
}

export const WORKFLOW_CONTROL_FIELDS: Readonly<Record<WorkflowControlRole, WorkflowControlField>>
export function validateWorkflowControlValue(role: WorkflowControlRole, value: unknown): number
