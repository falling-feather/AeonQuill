import {
  Boxes,
  Check,
  ChevronRight,
  CopyPlus,
  FileAudio2,
  FileVideo2,
  FolderPlus,
  Image as ImageIcon,
  Library,
  Link2,
  LoaderCircle,
  Search,
  Tag,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createLibraryCollection,
  deriveLibraryAsset,
  ensureLibraryProject,
  importLibraryAsset,
  linkLibraryAssetToProject,
  listLibraryAssets,
  listLibraryCollections,
  readLibraryFile,
  type LibraryAsset,
  type LibraryCollection,
  type LibraryScope,
} from '../../lib/libraryApi'
import './asset-library.css'

export type AssetLibraryProject = {
  id: string
  title: string
}

export type AssetLibraryDialogProps = {
  open: boolean
  projects: readonly AssetLibraryProject[]
  activeProjectId?: string
  modeLabel?: string
  onClose: () => void
  onUseAsset?: (asset: LibraryAsset) => void | Promise<void>
}

const MAX_IMPORT_BYTES = 32 * 1024 * 1024

function parseTags(value: string) {
  return [...new Set(value.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean))].slice(0, 12)
}

function readableBytes(bytes: number) {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function mediaLabel(asset: LibraryAsset) {
  if (asset.mediaKind === 'video') return '视频'
  if (asset.mediaKind === 'audio') return '音频'
  return '图像'
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

export function AssetLibraryDialog({
  open,
  projects,
  activeProjectId,
  modeLabel,
  onClose,
  onUseAsset,
}: AssetLibraryDialogProps) {
  const [scope, setScope] = useState<LibraryScope>('global')
  const [projectId, setProjectId] = useState(activeProjectId ?? projects[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [settledQuery, setSettledQuery] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [assets, setAssets] = useState<LibraryAsset[]>([])
  const [collections, setCollections] = useState<LibraryCollection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importTitle, setImportTitle] = useState('')
  const [importTags, setImportTags] = useState('')
  const [newCollectionTitle, setNewCollectionTitle] = useState('')
  const closeRef = useRef<HTMLButtonElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef(0)

  const usableProjectId = projectId || activeProjectId || projects[0]?.id || ''
  const selected = useMemo(
    () => assets.find((asset) => asset.id === selectedId) ?? assets[0] ?? null,
    [assets, selectedId],
  )

  const refresh = useCallback(async () => {
    if (!open || (scope === 'project' && !usableProjectId)) {
      setAssets([])
      setCollections([])
      return
    }
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setLoading(true)
    setError(null)
    try {
      const [nextAssets, nextCollections] = await Promise.all([
        listLibraryAssets({
          scope,
          projectId: scope === 'project' ? usableProjectId : undefined,
          query: settledQuery,
          collectionId: collectionId || undefined,
        }),
        listLibraryCollections(scope, scope === 'project' ? usableProjectId : undefined),
      ])
      if (requestRef.current !== requestId) return
      setAssets(nextAssets)
      setCollections(nextCollections)
      setSelectedId((current) => nextAssets.some(({ id }) => id === current) ? current : nextAssets[0]?.id ?? null)
    } catch (nextError) {
      if (requestRef.current !== requestId) return
      setAssets([])
      setCollections([])
      setError(nextError instanceof Error ? nextError.message : '资源库读取失败')
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }, [collectionId, open, scope, settledQuery, usableProjectId])

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledQuery(query.trim()), 180)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!open) return
    if (activeProjectId && projects.some(({ id }) => id === activeProjectId)) setProjectId(activeProjectId)
    setMessage(null)
    window.requestAnimationFrame(() => closeRef.current?.focus())
  }, [activeProjectId, open, projects])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null

  const switchScope = (next: LibraryScope) => {
    setScope(next)
    setCollectionId('')
    setSelectedId(null)
    setMessage(null)
  }

  const submitImport = async () => {
    if (!importFile) {
      setError('请先选择图片、视频或音频文件。')
      return
    }
    if (importFile.size <= 0 || importFile.size > MAX_IMPORT_BYTES) {
      setError('单个导入文件必须大于 0 且不超过 32MB。')
      return
    }
    if (scope === 'project' && !usableProjectId) {
      setError('项目资源必须绑定一个项目。')
      return
    }
    setBusy('import')
    setError(null)
    setMessage(null)
    try {
      if (scope === 'project') await ensureLibraryProject(usableProjectId)
      const asset = await importLibraryAsset({
        scope,
        projectId: scope === 'project' ? usableProjectId : undefined,
        title: importTitle.trim() || importFile.name.replace(/\.[^.]+$/u, ''),
        tags: parseTags(importTags),
        collectionIds: collectionId ? [collectionId] : [],
        dataUrl: await readLibraryFile(importFile),
      })
      setImportFile(null)
      setImportTitle('')
      setImportTags('')
      setImportOpen(false)
      setMessage(`“${asset.title}”已写入${scope === 'global' ? '全局' : '项目'}资源库。`)
      await refresh()
      setSelectedId(asset.id)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '资源导入失败')
    } finally {
      setBusy(null)
    }
  }

  const createCollection = async () => {
    const title = newCollectionTitle.trim()
    if (!title) return
    setBusy('collection')
    setError(null)
    try {
      if (scope === 'project') await ensureLibraryProject(usableProjectId)
      const collection = await createLibraryCollection({
        scope,
        projectId: scope === 'project' ? usableProjectId : undefined,
        title,
      })
      setNewCollectionTitle('')
      setCollectionId(collection.id)
      setMessage(`集合“${collection.title}”已创建。`)
      await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '集合创建失败')
    } finally {
      setBusy(null)
    }
  }

  const linkSelected = async (useAfterLink: boolean) => {
    if (!selected || !usableProjectId) return
    setBusy(useAfterLink ? 'use' : 'link')
    setError(null)
    try {
      await ensureLibraryProject(usableProjectId)
      const linked = selected.scope === 'global'
        ? await linkLibraryAssetToProject(selected.id, usableProjectId, selected.version.id)
        : selected
      setMessage(`已将“${linked.title}”固定到当前项目的 v${linked.version.version}。`)
      if (useAfterLink) await onUseAsset?.(linked)
      if (scope === 'project') await refresh()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '资源加入项目失败')
    } finally {
      setBusy(null)
    }
  }

  const deriveSelected = async () => {
    if (!selected || !usableProjectId) return
    setBusy('derive')
    setError(null)
    try {
      await ensureLibraryProject(usableProjectId)
      const derived = await deriveLibraryAsset(selected.id, {
        projectId: usableProjectId,
        sourceVersionId: selected.version.id,
        title: `${selected.title} · 项目派生`,
        tags: selected.tags,
      })
      setScope('project')
      setCollectionId('')
      setSettledQuery('')
      setQuery('')
      setSelectedId(derived.id)
      setMessage(`已建立独立派生资产；全局原件“${selected.title}”保持不变。`)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '派生资产创建失败')
    } finally {
      setBusy(null)
    }
  }

  const canUse = Boolean(selected && usableProjectId && onUseAsset)

  return (
    <div className="aq-library-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="aq-library-dialog" role="dialog" aria-modal="true" aria-labelledby="aq-library-title">
        <header className="aq-library-header">
          <div className="aq-library-heading">
            <span className="aq-library-heading__mark"><Library size={20} /></span>
            <div>
              <h2 id="aq-library-title">资源库</h2>
              <p>一份内容，多模式复用；项目派生不会覆盖全局原件。</p>
            </div>
          </div>
          <button ref={closeRef} type="button" className="aq-library-close" aria-label="关闭资源库" onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <div className="aq-library-toolbar">
          <div className="aq-library-scope" role="tablist" aria-label="资源范围">
            <button type="button" role="tab" aria-selected={scope === 'global'} className={scope === 'global' ? 'is-selected' : ''} onClick={() => switchScope('global')}>
              <Boxes size={15} /> 全局资源
            </button>
            <button type="button" role="tab" aria-selected={scope === 'project'} className={scope === 'project' ? 'is-selected' : ''} onClick={() => switchScope('project')}>
              <Link2 size={15} /> 项目资源
            </button>
          </div>
          <label className="aq-library-project">
            <span>目标项目</span>
            <select value={usableProjectId} disabled={!projects.length} onChange={(event) => {
              setProjectId(event.target.value)
              setCollectionId('')
            }}>
              {!projects.length ? <option value="">暂无项目</option> : null}
              {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
            </select>
          </label>
          <button type="button" className="aq-library-import-trigger" onClick={() => setImportOpen((current) => !current)}>
            <Upload size={15} /> 导入资源
          </button>
        </div>

        <div className="aq-library-layout">
          <aside className="aq-library-sidebar" aria-label="资源筛选">
            <label className="aq-library-search">
              <Search size={15} />
              <span className="aq-sr-only">搜索资源</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或标签" />
            </label>

            <div className="aq-library-collections">
              <strong>集合</strong>
              <button type="button" className={!collectionId ? 'is-selected' : ''} onClick={() => setCollectionId('')}>
                <Library size={14} /> 全部资源 <span>{assets.length}</span>
              </button>
              {collections.map((collection) => (
                <button key={collection.id} type="button" className={collectionId === collection.id ? 'is-selected' : ''} onClick={() => setCollectionId(collection.id)}>
                  <Tag size={14} /> {collection.title} <span>{collection.itemCount ?? 0}</span>
                </button>
              ))}
            </div>

            <form className="aq-library-new-collection" onSubmit={(event) => { event.preventDefault(); void createCollection() }}>
              <label htmlFor="aq-library-collection-title">新建集合</label>
              <div>
                <input id="aq-library-collection-title" value={newCollectionTitle} maxLength={80} placeholder="集合名称" onChange={(event) => setNewCollectionTitle(event.target.value)} />
                <button type="submit" aria-label="创建集合" disabled={!newCollectionTitle.trim() || busy === 'collection'}>
                  {busy === 'collection' ? <LoaderCircle className="is-spinning" size={15} /> : <FolderPlus size={15} />}
                </button>
              </div>
            </form>
          </aside>

          <main className="aq-library-content">
            {importOpen ? (
              <section className="aq-library-import" aria-label="导入资源">
                <button type="button" className="aq-library-dropzone" onClick={() => fileRef.current?.click()}>
                  <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp,video/mp4,audio/mpeg,audio/wav,audio/ogg" onChange={(event) => {
                    const file = event.target.files?.[0] ?? null
                    setImportFile(file)
                    if (file && !importTitle) setImportTitle(file.name.replace(/\.[^.]+$/u, ''))
                    event.currentTarget.value = ''
                  }} />
                  <Upload size={20} />
                  <span>{importFile ? importFile.name : '选择图片、MP4 或音频'}</span>
                  <small>{importFile ? readableBytes(importFile.size) : '单文件上限 32MB；原始内容按 SHA-256 去重保存'}</small>
                </button>
                <div className="aq-library-import-fields">
                  <label><span>名称</span><input value={importTitle} maxLength={120} onChange={(event) => setImportTitle(event.target.value)} /></label>
                  <label><span>标签</span><input value={importTags} placeholder="人物, 广告, 水墨" onChange={(event) => setImportTags(event.target.value)} /></label>
                </div>
                <button type="button" className="aq-library-import-submit" disabled={!importFile || busy === 'import'} onClick={() => void submitImport()}>
                  {busy === 'import' ? <LoaderCircle className="is-spinning" size={15} /> : <Check size={15} />} 写入{scope === 'global' ? '全局' : '项目'}资源库
                </button>
              </section>
            ) : null}

            {error ? <div className="aq-library-feedback is-error" role="alert">{error}</div> : null}
            {message ? <div className="aq-library-feedback is-success" role="status">{message}</div> : null}

            <div className="aq-library-content-heading">
              <div><strong>{scope === 'global' ? '全局原件' : '当前项目资产'}</strong><span>{assets.length} 项</span></div>
              {loading ? <span><LoaderCircle className="is-spinning" size={14} /> 正在同步</span> : null}
            </div>

            {loading && !assets.length ? (
              <div className="aq-library-empty"><LoaderCircle className="is-spinning" size={24} /><span>正在读取资源索引…</span></div>
            ) : !assets.length ? (
              <div className="aq-library-empty"><ImageIcon size={27} /><strong>这里还没有资源</strong><span>{query || collectionId ? '清除筛选，或导入一个新资源。' : '导入素材后，可在三种模式之间安全复用。'}</span></div>
            ) : (
              <ul className="aq-library-grid">
                {assets.map((asset) => {
                  const MediaIcon = asset.mediaKind === 'video' ? FileVideo2 : asset.mediaKind === 'audio' ? FileAudio2 : ImageIcon
                  return (
                    <li key={asset.id}>
                      <button type="button" aria-pressed={selected?.id === asset.id} className={selected?.id === asset.id ? 'is-selected' : ''} onClick={() => setSelectedId(asset.id)}>
                        <span className="aq-library-thumb">
                          {asset.mediaKind === 'image' ? <img src={asset.version.url} alt="" loading="lazy" /> : <MediaIcon size={27} />}
                          <em>v{asset.version.version}</em>
                        </span>
                        <span className="aq-library-tile-copy"><strong>{asset.title}</strong><small>{mediaLabel(asset)} · {readableBytes(asset.version.bytes)}</small></span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </main>

          <aside className="aq-library-inspector" aria-label="资源详情">
            {!selected ? (
              <div className="aq-library-inspector-empty"><ChevronRight size={20} /><span>选择一个资源查看版本与投递操作</span></div>
            ) : (
              <>
                <div className="aq-library-inspector-preview">
                  {selected.mediaKind === 'image' ? <img src={selected.version.url} alt={selected.title} /> : selected.mediaKind === 'video' ? <FileVideo2 size={38} /> : <FileAudio2 size={38} />}
                </div>
                <div className="aq-library-inspector-title">
                  <span>{selected.relationship === 'global-reference' ? '项目引用' : selected.scope === 'global' ? '全局原件' : '项目派生'}</span>
                  <h3>{selected.title}</h3>
                  {selected.description ? <p>{selected.description}</p> : null}
                </div>
                <dl className="aq-library-meta">
                  <div><dt>版本</dt><dd>v{selected.version.version} / {selected.versionCount}</dd></div>
                  <div><dt>格式</dt><dd>{selected.version.extension.toUpperCase()}</dd></div>
                  <div><dt>大小</dt><dd>{readableBytes(selected.version.bytes)}</dd></div>
                  <div><dt>更新</dt><dd>{formatTime(selected.updatedAt)}</dd></div>
                </dl>
                <div className="aq-library-tags">
                  {selected.tags.length ? selected.tags.map((tag) => <span key={tag}><Tag size={11} />{tag}</span>) : <small>尚无标签</small>}
                </div>
                <div className="aq-library-actions">
                  <button type="button" className="is-primary" disabled={!canUse || Boolean(busy)} onClick={() => void linkSelected(true)}>
                    {busy === 'use' ? <LoaderCircle className="is-spinning" size={15} /> : <ChevronRight size={15} />}
                    {modeLabel ? `用于${modeLabel}` : '用于当前模式'}
                  </button>
                  {selected.scope === 'global' ? (
                    <>
                      <button type="button" disabled={!usableProjectId || Boolean(busy)} onClick={() => void linkSelected(false)}><Link2 size={15} /> 固定到项目</button>
                      <button type="button" disabled={!usableProjectId || Boolean(busy)} onClick={() => void deriveSelected()}><CopyPlus size={15} /> 创建可编辑派生</button>
                    </>
                  ) : null}
                </div>
                <p className="aq-library-policy">全局原件不可覆盖；编辑时请创建项目派生。项目引用固定到当前版本，后续全局更新不会静默改变作品。</p>
              </>
            )}
          </aside>
        </div>
      </section>
    </div>
  )
}
