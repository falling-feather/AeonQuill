import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react'

import {
  cancelVideoJob,
  createStorageCleanupJob,
  fetchStorageScan,
  fetchVideoJob,
  updateStoragePolicy,
} from '../../lib/videoApi'
import type {
  ProcessingJob,
  StoragePolicy,
  StorageRetentionDays,
  StorageScan,
} from '../../types'

interface StorageLifecyclePanelProps {
  open: boolean
  disabled: boolean
  projects: Array<{ id: string; title: string }>
}

const retentionLabels: Array<{ key: keyof StorageRetentionDays; label: string; hint: string }> = [
  { key: 'terminalInputs', label: '任务输入', hint: '过期后不可直接重试' },
  { key: 'intermediateOutputs', label: '中间母片', hint: '最终交付不受影响' },
  { key: 'previewCache', label: '预览缓存', hint: '需要时自动重建' },
  { key: 'comfyResiduals', label: 'Comfy 残留', hint: '仅光阴砚前缀文件' },
  { key: 'projectOrphans', label: '孤立资产', hint: '恢复点仍会保护' },
]

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** index
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`
}

function effectiveRetention(policy: StoragePolicy, projectId: string) {
  return {
    ...policy.retentionDays,
    ...(projectId ? policy.projectOverrides[projectId] : {}),
  }
}

function terminal(job?: ProcessingJob | null) {
  return Boolean(job && ['completed', 'failed', 'cancelled'].includes(job.status))
}

export function StorageLifecyclePanel({ open, disabled, projects }: StorageLifecyclePanelProps) {
  const [scopeProjectId, setScopeProjectId] = useState('')
  const [scan, setScan] = useState<StorageScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [fullScan, setFullScan] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [retention, setRetention] = useState<StorageRetentionDays | null>(null)
  const [policySaving, setPolicySaving] = useState(false)
  const [cleanupJob, setCleanupJob] = useState<ProcessingJob | null>(null)
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()

  const loadScan = useCallback(async (includeRuntimeRoots = false) => {
    setScanning(true)
    setError(undefined)
    try {
      const next = await fetchStorageScan(scopeProjectId || undefined, includeRuntimeRoots)
      setScan(next)
      setFullScan(includeRuntimeRoots)
      setSelected(new Set())
      setRetention(effectiveRetention(next.policy, scopeProjectId))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法读取空间快照')
    } finally {
      setScanning(false)
    }
  }, [scopeProjectId])

  useEffect(() => {
    if (!open) return
    void loadScan(false)
  }, [loadScan, open])

  useEffect(() => {
    if (!cleanupJob || terminal(cleanupJob)) return
    let disposed = false
    const poll = async () => {
      try {
        const next = await fetchVideoJob(cleanupJob.id)
        if (disposed) return
        setCleanupJob(next)
        if (next.status === 'completed') {
          const result = next.storageCleanup
          setMessage(result
            ? `已实际回收 ${formatBytes(result.reclaimedBytes)}；${result.failures.length} 项失败、${result.skipped.length} 项因状态变化保留。复扫${result.verification.consistent ? '一致' : '需要人工确认'}。`
            : '空间清理已完成，正在重新扫描。')
          await loadScan(false)
          return
        }
        if (next.status === 'failed') {
          setError(next.error?.message ?? '空间清理失败；所有未确认项均已保留。')
          return
        }
        if (next.status === 'cancelled') {
          setMessage('空间清理已取消；已完成项不会回滚，已重新扫描剩余候选。')
          await loadScan(false)
          return
        }
        window.setTimeout(poll, 700)
      } catch (nextError) {
        if (!disposed) setError(nextError instanceof Error ? nextError.message : '无法跟踪空间清理任务')
      }
    }
    const timer = window.setTimeout(poll, 300)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [cleanupJob?.id, cleanupJob?.status, loadScan])

  const selectedCandidates = useMemo(() => {
    if (!scan) return []
    return scan.candidates.filter(({ id }) => selected.has(id))
  }, [scan, selected])
  const selectedBytes = selectedCandidates.reduce((sum, candidate) => sum + candidate.bytes, 0)
  const cleanupBusy = Boolean(cleanupJob && !terminal(cleanupJob))
  const busy = disabled || scanning || policySaving || cleanupBusy

  const saveRetention = async () => {
    if (!scan || !retention) return
    setPolicySaving(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const projectOverrides = structuredClone(scan.policy.projectOverrides)
      if (scopeProjectId) projectOverrides[scopeProjectId] = { ...retention }
      await updateStoragePolicy({
        baseRevision: scan.policy.revision,
        ...(scopeProjectId ? { projectOverrides } : { retentionDays: retention }),
      })
      setMessage(scopeProjectId ? '当前项目的分类保留期已保存。' : '全局分类保留期已保存。')
      await loadScan(false)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '保留策略保存失败')
    } finally {
      setPolicySaving(false)
    }
  }

  const clearProjectOverride = async () => {
    if (!scan || !scopeProjectId) return
    setPolicySaving(true)
    setError(undefined)
    try {
      const projectOverrides = structuredClone(scan.policy.projectOverrides)
      delete projectOverrides[scopeProjectId]
      await updateStoragePolicy({ baseRevision: scan.policy.revision, projectOverrides })
      setMessage('当前项目已恢复使用全局保留策略。')
      await loadScan(false)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法恢复全局保留策略')
    } finally {
      setPolicySaving(false)
    }
  }

  const beginCleanup = async () => {
    if (!scan || !selectedCandidates.length) return
    setError(undefined)
    setMessage(undefined)
    try {
      const job = await createStorageCleanupJob({
        scanId: scan.scanId,
        fingerprint: scan.fingerprint,
        candidateIds: selectedCandidates.map(({ id }) => id),
        acknowledgedBytes: selectedBytes,
      })
      setCleanupJob(job)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法启动安全清理')
    }
  }

  return (
    <section className="aq-storage-lifecycle" aria-labelledby="aq-storage-lifecycle-title">
      <div className="aq-runtime-settings__section-title aq-storage-lifecycle__heading">
        <div>
          <h3 id="aq-storage-lifecycle-title">空间与保留策略</h3>
          <p>只清理扫描快照中的受管候选；模型、运行中任务、项目引用、恢复点和最终交付始终受保护。</p>
        </div>
        <Database size={19} aria-hidden="true" />
      </div>

      <div className="aq-storage-lifecycle__toolbar">
        <label>
          <span>统计范围</span>
          <select
            value={scopeProjectId}
            onChange={(event) => setScopeProjectId(event.target.value)}
            disabled={busy}
            aria-label="空间统计项目范围"
          >
            <option value="">全部项目</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select>
        </label>
        <div>
          <button type="button" onClick={() => void loadScan(false)} disabled={busy}>
            <RefreshCw className={scanning && !fullScan ? 'is-spinning' : undefined} size={14} />
            快速复扫
          </button>
          <button type="button" onClick={() => void loadScan(true)} disabled={busy}>
            <HardDrive className={scanning && fullScan ? 'is-spinning' : undefined} size={14} />
            含模型完整扫描
          </button>
        </div>
      </div>

      {error ? <div className="aq-storage-lifecycle__feedback is-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}
      {message ? <div className="aq-storage-lifecycle__feedback is-success" role="status"><CheckCircle2 size={15} />{message}</div> : null}

      {scanning && !scan ? (
        <div className="aq-storage-lifecycle__empty"><LoaderCircle className="is-spinning" size={18} />正在建立只读空间快照…</div>
      ) : scan ? (
        <>
          <div className="aq-storage-lifecycle__capacity">
            <article className={`is-${scan.capacity.status}`}>
              <small>当前磁盘可用</small>
              <strong>{formatBytes(scan.capacity.freeBytes)}</strong>
              <span>安全预留 {formatBytes(scan.capacity.reserveBytes)}</span>
            </article>
            <article>
              <small>受管内容统计</small>
              <strong>{formatBytes(scan.totals.bytes)}</strong>
              <span>{scan.totals.files.toLocaleString('zh-CN')} 个文件</span>
            </article>
            <article>
              <small>可审核候选</small>
              <strong>{formatBytes(scan.totals.candidateBytes)}</strong>
              <span>{scan.totals.candidateFiles.toLocaleString('zh-CN')} 项；未自动选择</span>
            </article>
            <article>
              <small>720P 质量镜头</small>
              <strong>{scan.estimates.find(({ id }) => id === 'video-quality-720p')?.available ? '空间充足' : '空间不足'}</strong>
              <span>按单镜头约 {formatBytes(scan.estimates.find(({ id }) => id === 'video-quality-720p')?.requiredBytes ?? 0)} 预估</span>
            </article>
          </div>

          <div className="aq-storage-lifecycle__categories" aria-label="空间分类统计">
            {scan.categories.map((category) => (
              <article key={category.id}>
                <span><strong>{category.label}</strong><small>{category.files.toLocaleString('zh-CN')} 文件</small></span>
                <em>{formatBytes(category.bytes)}</em>
                <small>
                  {category.candidateFiles
                    ? `候选 ${category.candidateFiles} · ${formatBytes(category.candidateBytes)}`
                    : category.id === 'models' && !fullScan
                      ? '完整扫描后统计'
                      : category.cleanable ? '当前无到期候选' : '只读保护'}
                </small>
                {category.roots.some(({ removalMode }) => removalMode === 'runtime-removal-check-only') ? (
                  <i><ShieldCheck size={12} />模型移除须通过反向引用门</i>
                ) : null}
              </article>
            ))}
          </div>

          <div className="aq-storage-lifecycle__policy">
            <div>
              <strong>{scopeProjectId ? '当前项目保留期' : '全局分类保留期'}</strong>
              <span>单位：天；范围 1–3650。缩短后仍需重新扫描并手动确认。</span>
            </div>
            <div className="aq-storage-lifecycle__policy-grid">
              {retention ? retentionLabels.map(({ key, label, hint }) => (
                <label key={key}>
                  <span>{label}</span>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={retention[key]}
                    onChange={(event) => setRetention((current) => current ? {
                      ...current,
                      [key]: Math.max(1, Math.min(3650, Number(event.target.value) || 1)),
                    } : current)}
                    disabled={busy}
                  />
                  <small>{hint}</small>
                </label>
              )) : null}
            </div>
            <footer>
              <span>
                {scopeProjectId && scan.policy.projectOverrides[scopeProjectId]
                  ? '此项目当前使用独立策略。'
                  : scopeProjectId ? '此项目当前继承全局策略。' : '项目独立策略会覆盖对应分类。'}
              </span>
              <div>
                {scopeProjectId && scan.policy.projectOverrides[scopeProjectId] ? (
                  <button type="button" onClick={() => void clearProjectOverride()} disabled={busy}>恢复全局</button>
                ) : null}
                <button type="button" onClick={() => void saveRetention()} disabled={busy || !retention}>
                  {policySaving ? <LoaderCircle className="is-spinning" size={14} /> : <Save size={14} />}
                  保存策略
                </button>
              </div>
            </footer>
          </div>

          <div className="aq-storage-lifecycle__candidates">
            <header>
              <div>
                <strong>逐项清理候选</strong>
                <span>候选快照有效至 {new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(scan.expiresAt)}</span>
              </div>
              <button
                type="button"
                disabled={busy || !scan.candidates.length}
                onClick={() => setSelected((current) => current.size === scan.candidates.length
                  ? new Set()
                  : new Set(scan.candidates.map(({ id }) => id)))}
              >
                {selected.size === scan.candidates.length && scan.candidates.length ? '取消全选' : '选择全部候选'}
              </button>
            </header>
            {scan.candidates.length ? (
              <div className="aq-storage-lifecycle__candidate-list">
                {scan.candidates.slice(0, 240).map((candidate) => (
                  <label key={candidate.id}>
                    <input
                      type="checkbox"
                      checked={selected.has(candidate.id)}
                      disabled={busy}
                      onChange={() => setSelected((current) => {
                        const next = new Set(current)
                        if (next.has(candidate.id)) next.delete(candidate.id)
                        else next.add(candidate.id)
                        return next
                      })}
                    />
                    <span><strong>{candidate.label}</strong><small>{candidate.reason}{candidate.projectId ? ` · ${candidate.projectId}` : ''}</small></span>
                    <em>{formatBytes(candidate.bytes)}</em>
                  </label>
                ))}
                {scan.candidates.length > 240 ? <p>列表仅展示前 240 项；“选择全部候选”仍会精确覆盖本次快照中的全部 {scan.candidates.length} 项。</p> : null}
              </div>
            ) : (
              <div className="aq-storage-lifecycle__empty is-ready"><ShieldCheck size={17} />当前没有满足安全条件的到期文件。</div>
            )}
            <footer>
              <span>已选 {selectedCandidates.length} 项 · 预计回收 {formatBytes(selectedBytes)}</span>
              <button type="button" className="is-danger" onClick={() => void beginCleanup()} disabled={busy || !selectedCandidates.length}>
                <Trash2 size={14} />确认并开始安全清理
              </button>
            </footer>
          </div>

          {cleanupJob ? (
            <div className={`aq-storage-lifecycle__job is-${cleanupJob.status}`} role="status">
              <span>{cleanupJob.status === 'completed' ? <CheckCircle2 size={17} /> : cleanupJob.status === 'failed' ? <XCircle size={17} /> : <LoaderCircle className={cleanupBusy ? 'is-spinning' : undefined} size={17} />}</span>
              <div><strong>{cleanupJob.label}</strong><small>{cleanupJob.detail}</small><i style={{ width: `${cleanupJob.progress}%` }} /></div>
              {cleanupBusy ? <button type="button" onClick={() => void cancelVideoJob(cleanupJob.id)}><XCircle size={14} />取消</button> : null}
            </div>
          ) : null}

          <p className="aq-storage-lifecycle__safety">
            当前保护 {scan.references.projectAssets} 个工作区资产引用、{scan.references.jobAssets} 个任务输出引用和 {scan.references.recoveryPoints} 个恢复点；不跟随符号链接，不扫描用户自选目录中的未知文件。
          </p>
        </>
      ) : null}
    </section>
  )
}
