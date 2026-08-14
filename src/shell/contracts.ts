import type { ProductModeId } from './modeRegistry'

export type RuntimeSurfaceId = 'bridge' | 'comfyui' | 'gpu' | 'models' | 'storage'

export type RuntimeHealth = 'ready' | 'busy' | 'starting' | 'offline' | 'unavailable' | 'checking'

export interface RuntimeSurfaceSummary {
  id: RuntimeSurfaceId
  label: string
  status: RuntimeHealth
  statusLabel: string
  detail?: string
  usagePercent?: number
  actionLabel?: string
}

export interface LocalRuntimeSummary {
  status: RuntimeHealth
  statusLabel: string
  detail?: string
  lastCheckedLabel?: string
  privacyNote?: string
  feedback?: ShellFeedback
  items: readonly RuntimeSurfaceSummary[]
}

export interface RecentProjectSummary {
  id: string
  title: string
  modeId: ProductModeId
  updatedLabel: string
  previewUrl?: string
  description?: string
}

export type ModeAvailability = 'available' | 'degraded' | 'unavailable'

export interface ModeAvailabilitySummary {
  status: ModeAvailability
  label: string
  reason?: string
}

export type ShellFeedbackStatus = 'loading' | 'empty' | 'error' | 'recovered' | 'info'

export interface ShellFeedback {
  status: ShellFeedbackStatus
  title: string
  detail?: string
  actionLabel?: string
  secondaryActionLabel?: string
}
