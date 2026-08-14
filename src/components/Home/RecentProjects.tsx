import { ArrowUpRight, FilePlus2, FolderOpen } from 'lucide-react'
import type { RecentProjectSummary } from '../../shell/contracts'

interface RecentProjectsProps {
  projects: readonly RecentProjectSummary[]
  onCreateProject?: () => void
  onOpenProject?: (projectId: string) => void
}

export function RecentProjects({
  projects,
  onCreateProject,
  onOpenProject,
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
          新建项目
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="aq-recent__empty">
          <span className="aq-recent__empty-icon" aria-hidden="true">
            <FolderOpen size={28} strokeWidth={1.35} />
          </span>
          <div>
            <strong>尚无项目</strong>
            <p>创建你的第一个项目，开启创作之旅。</p>
          </div>
        </div>
      ) : (
        <ul className="aq-project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className="aq-project-row"
                onClick={() => onOpenProject?.(project.id)}
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
      )}
    </section>
  )
}
