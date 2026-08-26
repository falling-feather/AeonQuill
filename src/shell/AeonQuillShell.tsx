import { useMemo, useState } from 'react'
import {
  Archive,
  Blend,
  Check,
  Clapperboard,
  Clock3,
  Folder,
  FolderOpen,
  Grid3X3,
  History,
  ListFilter,
  MoreHorizontal,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react'
import { HomeHeader, ProjectCreateDialog, RuntimeSummary, SurfaceState } from '../components/Home'
import type {
  LocalRuntimeSummary,
  ModeAvailabilitySummary,
  ProjectCreateInput,
  RecentProjectSummary,
  RuntimeSurfaceSummary,
  ShellFeedback,
} from './contracts'
import { defaultModeRegistry, type ModeManifest, type ProductModeId } from './modeRegistry'
import './shell.css'

type ProjectCollection = 'all' | 'recent' | 'archived' | 'trashed'
type ModeFilter = 'all' | ProductModeId
type ProjectStatus = NonNullable<RecentProjectSummary['status']>

const MODE_ICONS = {
  balanced: Blend,
  pixel: Grid3X3,
  'smart-video': Clapperboard,
} as const

const MODE_LABELS: Record<ProductModeId, string> = {
  balanced: '均衡模式',
  pixel: '像素模式',
  'smart-video': '智能视频',
}

const COLLECTIONS: Array<{ id: ProjectCollection; label: string; icon: typeof Folder }> = [
  { id: 'all', label: '全部项目', icon: Folder },
  { id: 'recent', label: '最近打开', icon: Clock3 },
  { id: 'archived', label: '已归档', icon: Archive },
  { id: 'trashed', label: '回收站', icon: Trash2 },
]

function documentCount(project: RecentProjectSummary, modeId: ProductModeId) {
  return project.documentCounts?.[modeId] ?? 0
}

export interface AeonQuillShellProps {
  modes?: readonly ModeManifest[]
  selectedModeId?: ProductModeId
  modeAvailability?: Partial<Record<ProductModeId, ModeAvailabilitySummary>>
  runtime: LocalRuntimeSummary
  recentProjects?: readonly RecentProjectSummary[]
  recentProjectsFeedback?: ShellFeedback
  refreshingRuntime?: boolean
  onModeSelect?: (modeId: ProductModeId) => void
  onCreateProject?: (input: ProjectCreateInput) => void
  onOpenProject?: (projectId: string, modeId: ProductModeId) => void
  onProjectStatusChange?: (projectId: string, status: ProjectStatus) => void
  onOpenProjectRecovery?: (projectId: string) => void
  onRetryProjects?: () => void
  onOpenLibrary?: () => void
  onOpenSettings?: () => void
  onRefreshRuntime?: () => void
  onRuntimeItemAction?: (item: RuntimeSurfaceSummary) => void
}

export function AeonQuillShell({
  modes = defaultModeRegistry.list(),
  selectedModeId = 'balanced',
  modeAvailability,
  runtime,
  recentProjects = [],
  recentProjectsFeedback,
  refreshingRuntime = false,
  onModeSelect,
  onCreateProject,
  onOpenProject,
  onProjectStatusChange,
  onOpenProjectRecovery,
  onRetryProjects,
  onOpenLibrary,
  onOpenSettings,
  onRefreshRuntime,
  onRuntimeItemAction,
}: AeonQuillShellProps) {
  const [collection, setCollection] = useState<ProjectCollection>('all')
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'updated' | 'opened' | 'name'>('updated')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [actionProjectId, setActionProjectId] = useState<string | null>(null)

  const initialDialogMode = modeFilter === 'all' ? selectedModeId : modeFilter
  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    const filtered = recentProjects.filter((project) => {
      const status = project.status ?? 'active'
      const collectionMatch = collection === 'all'
        ? status === 'active'
        : collection === 'recent'
          ? status === 'active'
          : status === collection
      const modeMatch = modeFilter === 'all' || documentCount(project, modeFilter) > 0
      const queryMatch = !needle || `${project.title} ${project.description ?? ''}`.toLocaleLowerCase('zh-CN').includes(needle)
      return collectionMatch && modeMatch && queryMatch
    })
    return [...filtered].sort((left, right) => {
      if (sort === 'name') return left.title.localeCompare(right.title, 'zh-CN')
      if (sort === 'opened') return (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0)
      return (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || left.title.localeCompare(right.title, 'zh-CN')
    })
  }, [collection, modeFilter, query, recentProjects, sort])

  const chooseMode = (modeId: ModeFilter) => {
    setModeFilter(modeId)
    if (modeId !== 'all') onModeSelect?.(modeId)
  }

  const create = (input: ProjectCreateInput) => {
    onCreateProject?.(input)
    setDialogOpen(false)
  }

  return (
    <div className="aq-shell aq-project-center-shell">
      <HomeHeader onOpenSettings={onOpenSettings} onOpenLibrary={onOpenLibrary} onCreateProject={() => setDialogOpen(true)} />

      <main className="aq-project-center">
        <aside className="aq-project-sidebar" aria-label="项目导航">
          <nav className="aq-project-sidebar__collections" aria-label="项目集合">
            {COLLECTIONS.map((item) => {
              const Icon = item.icon
              return (
                <button key={item.id} type="button" className={collection === item.id ? 'is-selected' : ''} aria-current={collection === item.id ? 'page' : undefined} onClick={() => setCollection(item.id)}>
                  <Icon size={17} strokeWidth={1.7} />
                  {item.label}
                </button>
              )
            })}
          </nav>

          <div className="aq-project-sidebar__rule" />

          <nav className="aq-project-sidebar__modes" aria-label="按创作模式筛选">
            {modes.map((mode) => {
              const Icon = MODE_ICONS[mode.id]
              return (
                <button key={mode.id} type="button" className={`is-${mode.accent} ${modeFilter === mode.id ? 'is-selected' : ''}`} aria-pressed={modeFilter === mode.id} onClick={() => chooseMode(mode.id)}>
                  <Icon size={18} strokeWidth={1.7} />
                  <span>{mode.title}</span>
                </button>
              )
            })}
          </nav>

          <div className="aq-project-sidebar__ink" aria-hidden="true" />
        </aside>

        <section className="aq-project-main" aria-labelledby="aq-home-title">
          <header className="aq-project-heading">
            <div>
              <h1 id="aq-home-title" tabIndex={-1}>项目中心</h1>
              <p>每个项目都可以使用均衡、像素与智能视频三种创作模式。</p>
            </div>
            <div className="aq-project-mode-switch" role="group" aria-label="模式筛选">
              <button type="button" className={modeFilter === 'all' ? 'is-selected' : ''} onClick={() => chooseMode('all')}>全部模式</button>
              {modes.map((mode) => {
                const Icon = MODE_ICONS[mode.id]
                return (
                  <button key={mode.id} type="button" className={`is-${mode.accent} ${modeFilter === mode.id ? 'is-selected' : ''}`} onClick={() => chooseMode(mode.id)} title={modeAvailability?.[mode.id]?.reason}>
                    <Icon size={15} strokeWidth={1.7} /> {mode.title}
                  </button>
                )
              })}
            </div>
          </header>

          <div className="aq-project-toolbar">
            <label className="aq-project-search">
              <Search size={16} strokeWidth={1.8} aria-hidden="true" />
              <span className="aq-sr-only">搜索项目</span>
              <input value={query} placeholder="搜索项目名称或描述" onChange={(event) => setQuery(event.target.value)} />
            </label>
            <label className="aq-project-sort">
              <ListFilter size={15} />
              <span className="aq-sr-only">项目排序</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
                <option value="updated">最近更新</option>
                <option value="opened">最近打开</option>
                <option value="name">项目名称</option>
              </select>
            </label>
            <span className="aq-project-total">{visibleProjects.length} 个项目</span>
          </div>

          <div className="aq-project-table" role="region" aria-label="项目列表">
            <div className="aq-project-table__head" aria-hidden="true">
              <span>项目</span><span>文档数（均衡 / 像素 / 视频）</span><span>最近更新</span><span>存储</span><span>操作</span>
            </div>

            {recentProjectsFeedback?.status === 'loading' && recentProjects.length === 0 ? (
              <SurfaceState feedback={recentProjectsFeedback} />
            ) : recentProjectsFeedback?.status === 'error' && recentProjects.length === 0 ? (
              <SurfaceState feedback={recentProjectsFeedback} onAction={onRetryProjects} />
            ) : visibleProjects.length === 0 ? (
              <div className="aq-project-empty">
                <span><FolderOpen size={25} /></span>
                <strong>{query ? '没有符合条件的项目' : collection === 'trashed' ? '回收站为空' : '从第一个项目开始'}</strong>
                <p>{query ? '尝试更换关键词、集合或模式筛选。' : '创建项目后，三种模式的文档会在这里统一管理。'}</p>
                {!query && collection !== 'trashed' ? <button type="button" onClick={() => setDialogOpen(true)}>创建新项目</button> : null}
              </div>
            ) : (
              <ul className="aq-project-rows">
                {visibleProjects.map((project) => {
                  const status = project.status ?? 'active'
                  const ModeIcon = MODE_ICONS[project.modeId]
                  const menuOpen = actionProjectId === project.id
                  return (
                    <li key={project.id} className={`is-${project.color ?? 'amber'}`}>
                      <button type="button" className="aq-project-row-main" disabled={status !== 'active'} onClick={() => onOpenProject?.(project.id, project.modeId)}>
                        <span className="aq-project-cover" aria-hidden="true">{project.previewUrl ? <img src={project.previewUrl} alt="" /> : <ModeIcon size={25} strokeWidth={1.45} />}</span>
                        <span className="aq-project-copy">
                          <strong>{project.title}</strong>
                          <span><ModeIcon size={13} /> 最近使用：{MODE_LABELS[project.modeId]}</span>
                          {project.description ? <small>{project.description}</small> : null}
                        </span>
                        <span className="aq-project-counts">{documentCount(project, 'balanced')} / {documentCount(project, 'pixel')} / {documentCount(project, 'smart-video')}</span>
                        <span className="aq-project-updated">{project.updatedLabel}</span>
                        <span className="aq-project-storage"><i />{project.storageLabel ?? '本机项目'}</span>
                      </button>
                      <div className="aq-project-actions">
                        {status !== 'active' ? <button type="button" onClick={() => onProjectStatusChange?.(project.id, 'active')}><RotateCcw size={15} /> 恢复</button> : null}
                        <button type="button" className="aq-project-more" aria-label={`打开${project.title}项目操作`} aria-expanded={menuOpen} onClick={() => setActionProjectId(menuOpen ? null : project.id)}><MoreHorizontal size={18} /></button>
                        {menuOpen ? (
                          <div className="aq-project-action-menu">
                            {status === 'active' ? (
                              <div className="aq-project-action-menu__modes" role="group" aria-label={`${project.title}模式文档`}>
                                {modes.map((mode) => {
                                  const Icon = MODE_ICONS[mode.id]
                                  const exists = documentCount(project, mode.id) > 0
                                  return (
                                    <button key={mode.id} type="button" onClick={() => { onOpenProject?.(project.id, mode.id); setActionProjectId(null) }}>
                                      <Icon size={14} /> {exists ? '打开' : '新建'}{mode.title}
                                    </button>
                                  )
                                })}
                              </div>
                            ) : null}
                            {status === 'active' ? <button type="button" onClick={() => { onProjectStatusChange?.(project.id, 'archived'); setActionProjectId(null) }}><Archive size={14} /> 归档</button> : null}
                            <button type="button" onClick={() => { onOpenProjectRecovery?.(project.id); setActionProjectId(null) }}><History size={14} /> 恢复点</button>
                            {status !== 'trashed' ? <button type="button" onClick={() => { onProjectStatusChange?.(project.id, 'trashed'); setActionProjectId(null) }}><Trash2 size={14} /> 移入回收站</button> : null}
                            {status === 'trashed' ? <span><Check size={14} /> 15 天后自动清理</span> : null}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <RuntimeSummary runtime={runtime} refreshing={refreshingRuntime} onRefresh={onRefreshRuntime} onItemAction={onRuntimeItemAction} />
        </section>
      </main>

      <ProjectCreateDialog open={dialogOpen} initialModeId={initialDialogMode} onClose={() => setDialogOpen(false)} onCreate={create} />
    </div>
  )
}
