import { useMemo, useState } from 'react'
import {
  BrandWelcome,
  HomeHeader,
  ModeCard,
  RecentProjects,
  RuntimeSummary,
} from '../components/Home'
import type {
  LocalRuntimeSummary,
  ModeAvailabilitySummary,
  RecentProjectSummary,
  RuntimeSurfaceSummary,
  ShellFeedback,
} from './contracts'
import {
  defaultModeRegistry,
  type ModeManifest,
  type ProductModeId,
} from './modeRegistry'
import './shell.css'

export interface AeonQuillShellProps {
  modes?: readonly ModeManifest[]
  selectedModeId?: ProductModeId
  modeAvailability?: Partial<Record<ProductModeId, ModeAvailabilitySummary>>
  runtime: LocalRuntimeSummary
  recentProjects?: readonly RecentProjectSummary[]
  recentProjectsFeedback?: ShellFeedback
  refreshingRuntime?: boolean
  onModeSelect?: (modeId: ProductModeId) => void
  onModeOpen?: (modeId: ProductModeId) => void
  onCreateProject?: (modeId: ProductModeId) => void
  onOpenProject?: (projectId: string, modeId: ProductModeId) => void
  onRetryProjects?: () => void
  onOpenSettings?: () => void
  onRefreshRuntime?: () => void
  onRuntimeItemAction?: (item: RuntimeSurfaceSummary) => void
}

export function AeonQuillShell({
  modes = defaultModeRegistry.list(),
  selectedModeId,
  modeAvailability,
  runtime,
  recentProjects = [],
  recentProjectsFeedback,
  refreshingRuntime = false,
  onModeSelect,
  onModeOpen,
  onCreateProject,
  onOpenProject,
  onRetryProjects,
  onOpenSettings,
  onRefreshRuntime,
  onRuntimeItemAction,
}: AeonQuillShellProps) {
  const fallbackModeId = modes[0]?.id ?? 'balanced'
  const [localModeId, setLocalModeId] = useState<ProductModeId>(fallbackModeId)
  const activeModeId = selectedModeId ?? localModeId
  const activeMode = useMemo(
    () => modes.find((mode) => mode.id === activeModeId) ?? modes[0],
    [activeModeId, modes],
  )

  const previewMode = (modeId: ProductModeId) => {
    if (selectedModeId === undefined) setLocalModeId(modeId)
    onModeSelect?.(modeId)
  }

  const activateMode = (modeId: ProductModeId) => {
    previewMode(modeId)
    if (modeAvailability?.[modeId]?.status !== 'unavailable') onModeOpen?.(modeId)
  }

  return (
    <div className="aq-shell">
      <HomeHeader onOpenSettings={onOpenSettings} />
      <main className="aq-home">
        <div className="aq-home-grid">
          <BrandWelcome />

          <section className="aq-mode-rail" aria-labelledby="aq-mode-rail-title">
            <h2 id="aq-mode-rail-title" className="aq-sr-only">选择创作模式</h2>
            <div className="aq-mode-rail__grid">
              {modes.map((mode) => (
                <ModeCard
                  key={mode.id}
                  mode={mode}
                  selected={mode.id === activeMode?.id}
                  availability={modeAvailability?.[mode.id]}
                  onPreview={previewMode}
                  onActivate={activateMode}
                />
              ))}
            </div>
          </section>

          <RecentProjects
            projects={recentProjects}
            feedback={recentProjectsFeedback}
            startLabel={`进入${activeMode?.title ?? '均衡模式'}`}
            onCreateProject={() => onCreateProject?.(activeMode?.id ?? 'balanced')}
            onOpenProject={onOpenProject}
            onRetry={onRetryProjects}
          />

          <RuntimeSummary
            runtime={runtime}
            refreshing={refreshingRuntime}
            onRefresh={onRefreshRuntime}
            onItemAction={onRuntimeItemAction}
          />
        </div>
      </main>
    </div>
  )
}
