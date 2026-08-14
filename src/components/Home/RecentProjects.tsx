import { ArrowUpRight, FilePlus2, FolderOpen } from 'lucide-react'
import type { RecentProjectSummary, ShellFeedback } from '../../shell/contracts'
import type { ProductModeId } from '../../shell/modeRegistry'
import { SurfaceState } from './SurfaceState'

interface RecentProjectsProps {
  projects: readonly RecentProjectSummary[]
  feedback?: ShellFeedback
  startLabel?: string
  onCreateProject?: () => void
  onOpenProject?: (projectId: string, modeId: ProductModeId) => void
  onRetry?: () => void
}

export function RecentProjects({
  projects,
  feedback,
  startLabel = '进入当前模式',
  onCreateProject,
  onOpenProject,
  onRetry,
}: RecentProjectsProps) {
  return (
    <section className="aq-recent" aria-labelledby="aq-recent-title">
      <div className="aq-section-heading">
        <div>
          <h2 id="aq-recent-title">最近项目</h2>
          <p>继续上一段创作，或从一个干净项目开始。</p>
        </div>
        <button type="button" className="aq-primary-action" onClick={onCreateProject}>
          <FilePlus2 size={17} strokeWidth={1.8} aria-hidden="true" />
          {startLabel}
        </button>
      </div>

      {feedback && (projects.length === 0 || feedback.status === 'error') ? (
        <SurfaceState
          feedback={feedback}
          compact={projects.length > 0}
          onAction={feedback.status === 'error' ? onRetry : onCreateProject}
        />
      ) : feedback?.status === 'recovered' ? (
        <SurfaceState feedback={feedback} compact />
      ) : null}

      {projects.length === 0 && !feedback ? (
        <div className="aq-recent__empty">
          <span className="aq-recent__empty-icon" aria-hidden="true">
            <FolderOpen size={28} strokeWidth={1.35} />
          </span>
          <div>
            <strong>尚无项目</strong>
            <p>创建你的第一个项目，开启创作之旅。</p>
          </div>
        </div>
      ) : projects.length > 0 ? (
        <ul className="aq-project-list">
          {projects.map((project) => (
            <li key={`${project.modeId}:${project.id}`}>
              <button
                type="button"
                className="aq-project-row"
                onClick={() => onOpenProject?.(project.id, project.modeId)}
                aria-label={`打开${project.title}，进入${project.modeId === 'balanced' ? '均衡模式' : project.modeId === 'pixel' ? '像素模式' : '智能视频'}`}
              >
                <span className="aq-project-row__preview" aria-hidden="true">
                  {project.previewUrl ? <img src={project.previewUrl} alt="" /> : <FolderOpen size={20} />}
                </span>
                <span className="aq-project-row__copy">
                  <strong>{project.title}</strong>
                  <span>{project.description ?? project.updatedLabel}</span>
                </span>
                <span className="aq-project-row__updated">{project.updatedLabel}</span>
                <ArrowUpRight size={17} strokeWidth={1.7} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
