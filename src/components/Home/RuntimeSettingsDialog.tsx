import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  FolderCog,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  ServerCog,
  ShieldCheck,
  X,
} from 'lucide-react'
import type {
  RuntimeConfigurationRequest,
  RuntimeDiagnostics,
} from '../../types'
import { pickNativeOutputDirectory, supportsNativeDirectoryPicker } from '../../lib/desktopDialog'

interface RuntimeSettingsDialogProps {
  open: boolean
  diagnostics: RuntimeDiagnostics | null
  loading: boolean
  saving: boolean
  error?: string
  message?: string
  onClose: () => void
  onRefresh: () => void
  onConfigure: (request: RuntimeConfigurationRequest) => void
}

function capabilityStatus(status: string) {
  if (status === 'ready') return { label: '可用', tone: 'ready' }
  if (status === 'sleeping') return { label: '已配置 · 休眠', tone: 'idle' }
  if (status === 'incomplete') return { label: '依赖不完整', tone: 'warning' }
  return { label: '需要配置', tone: 'warning' }
}

export function RuntimeSettingsDialog({
  open,
  diagnostics,
  loading,
  saving,
  error,
  message,
  onClose,
  onRefresh,
  onConfigure,
}: RuntimeSettingsDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [comfyRoot, setComfyRoot] = useState('')
  const [pythonPath, setPythonPath] = useState('')
  const [comfyUrl, setComfyUrl] = useState('http://127.0.0.1:8188')
  const [policy, setPolicy] = useState<'persistent' | 'idle' | 'manual'>('idle')
  const [idleSeconds, setIdleSeconds] = useState(300)
  const [outputDirectory, setOutputDirectory] = useState('')
  const [outputPickerError, setOutputPickerError] = useState<string>()

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [onClose, open])

  useEffect(() => {
    if (!diagnostics) return
    setComfyUrl(diagnostics.configuration.comfyUrl)
    setPolicy(diagnostics.configuration.launchPolicy)
    setIdleSeconds(diagnostics.configuration.idleSeconds)
  }, [diagnostics])

  useEffect(() => {
    if (!open) return
    setOutputDirectory('')
    setOutputPickerError(undefined)
  }, [open])

  if (!open) return null

  const image = diagnostics?.capabilities.image
  const comfy = diagnostics?.capabilities.comfyui
  const semantic = diagnostics?.capabilities.semantic
  const comfyHealth = capabilityStatus(comfy?.status ?? 'needs-configuration')
  const disabled = loading || saving

  const submitManual = (event: FormEvent) => {
    event.preventDefault()
    const request: RuntimeConfigurationRequest = {
      mode: 'manual',
      comfyUrl,
      comfyLaunchPolicy: policy,
      comfyIdleSeconds: idleSeconds,
    }
    if (comfyRoot.trim()) request.comfyRoot = comfyRoot.trim()
    if (pythonPath.trim()) request.pythonPath = pythonPath.trim()
    if (outputDirectory.trim()) request.outputDirectory = outputDirectory.trim()
    onConfigure(request)
  }

  return (
    <div
      className="aq-runtime-settings-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !saving) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="aq-runtime-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="aq-runtime-settings-title"
        aria-describedby="aq-runtime-settings-description"
      >
        <header className="aq-runtime-settings__header">
          <div>
            <span className="aq-runtime-settings__eyebrow">LOCAL RUNTIME CONTROL</span>
            <h2 id="aq-runtime-settings-title">本机能力与设置</h2>
            <p id="aq-runtime-settings-description">
              检查图像与视频执行器；配置只写入当前用户，不进入项目包或云端。
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="aq-runtime-settings__close"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭本机设置"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <div className="aq-runtime-settings__toolbar">
          <span>
            {diagnostics
              ? `上次检查 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(diagnostics.checkedAt)}`
              : '尚未取得诊断快照'}
          </span>
          <button type="button" onClick={onRefresh} disabled={disabled}>
            <RefreshCw className={loading ? 'is-spinning' : undefined} size={15} aria-hidden="true" />
            {loading ? '检查中' : '重新检测'}
          </button>
        </div>

        {error ? (
          <div className="aq-runtime-settings__feedback is-error" role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
        {message ? (
          <div className="aq-runtime-settings__feedback is-success" role="status">
            <CheckCircle2 size={17} aria-hidden="true" />
            <span>{message}</span>
          </div>
        ) : null}

        <div className="aq-runtime-settings__body">
          <section className="aq-runtime-settings__overview" aria-label="本机能力摘要">
            <article>
              <span className="aq-runtime-settings__icon"><HardDrive size={19} /></span>
              <div>
                <strong>项目与用户数据</strong>
                <span>{diagnostics?.storage.runtimeLabel ?? '正在检查写入位置'}</span>
              </div>
              <em className={diagnostics?.storage.runtimeWritable ? 'is-ready' : 'is-warning'}>
                {diagnostics?.storage.runtimeWritable ? '可写' : '不可写'}
              </em>
            </article>
            <article>
              <span className="aq-runtime-settings__icon"><ImageIcon size={19} /></span>
              <div>
                <strong>本机图像处理</strong>
                <span>{image ? `${image.available}/${image.total} 项正式处理器可用` : '正在探测执行器'}</span>
              </div>
              <em className={image?.available ? 'is-ready' : 'is-warning'}>
                {image?.available ? '可用' : '受限'}
              </em>
            </article>
            <article>
              <span className="aq-runtime-settings__icon"><ServerCog size={19} /></span>
              <div>
                <strong>ComfyUI 视频运行时</strong>
                <span>
                  {comfy?.connected
                    ? `${comfy.device ?? '设备待识别'} · 缺 ${comfy.missingNodes + comfy.missingModels} 项`
                    : diagnostics?.configuration.offlineRuntimePackageId
                      ? `内置离线运行时 · ${diagnostics.configuration.rootLabel ?? '已受管'}`
                      : diagnostics?.configuration.rootLabel ?? '尚未配置托管路径'}
                </span>
              </div>
              <em className={`is-${comfyHealth.tone}`}>{comfyHealth.label}</em>
            </article>
            <article>
              <span className="aq-runtime-settings__icon"><Cpu size={19} /></span>
              <div>
                <strong>语义图像工作流</strong>
                <span>{semantic ? `${semantic.ready}/${semantic.total} 项可执行 · ${semantic.installed} 项已安装` : '正在核对节点'}</span>
              </div>
              <em className={semantic?.ready ? 'is-ready' : 'is-idle'}>
                {semantic?.ready ? '部分可用' : '待依赖'}
              </em>
            </article>
          </section>

          <section className="aq-runtime-settings__issues" aria-labelledby="aq-runtime-issues-title">
            <div className="aq-runtime-settings__section-title">
              <div>
                <h3 id="aq-runtime-issues-title">诊断结果</h3>
                <p>所有状态来自本机实时探测，不使用演示数据。</p>
              </div>
              <ShieldCheck size={19} aria-hidden="true" />
            </div>
            {loading && !diagnostics ? (
              <div className="aq-runtime-settings__empty">
                <LoaderCircle className="is-spinning" size={20} aria-hidden="true" />
                正在建立本机诊断快照…
              </div>
            ) : diagnostics?.issues.length ? (
              <ul>
                {diagnostics.issues.map((issue) => (
                  <li key={issue.code} className={`is-${issue.severity}`}>
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span><strong>{issue.message}</strong><small>{issue.action}</small></span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="aq-runtime-settings__empty is-ready">
                <CheckCircle2 size={20} aria-hidden="true" />
                当前未发现阻断性本机依赖问题。
              </div>
            )}
          </section>

          <form className="aq-runtime-settings__form" onSubmit={submitManual}>
            <div className="aq-runtime-settings__section-title">
              <div>
                <h3>ComfyUI 托管配置</h3>
                <p>路径不会回显到诊断报告；留空时保留现有路径。</p>
              </div>
              <FolderCog size={19} aria-hidden="true" />
            </div>

            <div className="aq-runtime-settings__discovery">
              <div>
                <strong>自动发现常见安装</strong>
                <span>优先使用完整包内置运行时；否则检查已配置位置、用户目录及 C/D 盘浅层目录。</span>
              </div>
              <button
                type="button"
                onClick={() => onConfigure({ mode: 'auto-discover' })}
                disabled={disabled}
              >
                <Search size={15} aria-hidden="true" />
                自动发现
              </button>
            </div>

            <div className="aq-runtime-settings__fields">
              <div className="aq-runtime-settings__output-field">
                <span>成片输出目录</span>
                <div>
                  <input
                    value={outputDirectory}
                    onChange={(event) => {
                      setOutputDirectory(event.target.value)
                      setOutputPickerError(undefined)
                    }}
                    placeholder={diagnostics?.configuration.outputDirectoryLabel ?? '例如 D:\\AEONQUILL-Outputs'}
                    aria-label="成片输出目录"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setOutputPickerError(undefined)
                      void pickNativeOutputDirectory()
                        .then((selected) => {
                          if (selected) setOutputDirectory(selected)
                        })
                        .catch((nextError) => setOutputPickerError(nextError instanceof Error ? nextError.message : '无法打开目录选择器'))
                    }}
                    disabled={disabled}
                    title={supportsNativeDirectoryPicker() ? '打开系统文件夹选择器' : '网页调试态请手工输入路径'}
                  >
                    <FolderOpen size={15} aria-hidden="true" />
                    选择目录
                  </button>
                </div>
                <small>
                  {outputPickerError
                    ?? (diagnostics?.configuration.outputDirectoryConfigured
                      ? `自定义：${diagnostics.configuration.outputDirectoryLabel ?? '已配置目录'}；新任务完成后会复制交付成片。`
                      : `软件默认：${diagnostics?.configuration.outputDirectoryLabel ?? 'output 文件夹'}；未手工选择时自动写入。`)}
                </small>
                {diagnostics?.configuration.outputDirectoryConfigured ? (
                  <button
                    type="button"
                    className="aq-runtime-settings__output-clear"
                    onClick={() => onConfigure({ mode: 'manual', outputDirectory: null })}
                    disabled={disabled}
                  >
                    恢复软件默认 output
                  </button>
                ) : null}
              </div>
              <label>
                <span>ComfyUI 根目录</span>
                <input
                  value={comfyRoot}
                  onChange={(event) => setComfyRoot(event.target.value)}
                  placeholder={diagnostics?.configuration.rootLabel ?? '例如 D:\\ComfyUI_windows_portable\\ComfyUI'}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                />
                <small>目录内必须包含 main.py。</small>
              </label>
              <label>
                <span>Python 可执行文件</span>
                <input
                  value={pythonPath}
                  onChange={(event) => setPythonPath(event.target.value)}
                  placeholder={diagnostics?.configuration.pythonLabel ?? '例如 D:\\ComfyUI_windows_portable\\python_embeded\\python.exe'}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                />
                <small>可使用便携包自带 Python 或独立虚拟环境。</small>
              </label>
              <label>
                <span>回环地址</span>
                <input
                  value={comfyUrl}
                  onChange={(event) => setComfyUrl(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                />
                <small>只接受 127.0.0.1、localhost 或 ::1 的 HTTP 地址。</small>
              </label>
              <label>
                <span>运行策略</span>
                <select value={policy} onChange={(event) => setPolicy(event.target.value as typeof policy)} disabled={disabled}>
                  <option value="idle">任务后空闲关闭</option>
                  <option value="persistent">应用期间常驻</option>
                  <option value="manual">仅连接外部进程</option>
                </select>
                <small>推荐空闲关闭：任务结束后释放显存。</small>
              </label>
              <label>
                <span>空闲关闭秒数</span>
                <input
                  type="number"
                  min={30}
                  max={3600}
                  step={30}
                  value={idleSeconds}
                  onChange={(event) => setIdleSeconds(Number(event.target.value))}
                  disabled={disabled || policy !== 'idle'}
                />
                <small>允许 30–3600 秒；默认 300 秒。</small>
              </label>
            </div>

            <footer>
              <p>
                {diagnostics?.configuration.restartRequired
                  ? '磁盘配置与当前运行实例不同；关闭并重新打开应用后生效。'
                  : '运行策略可立即生效；执行器路径变更需要重新打开应用。'}
              </p>
              <button type="submit" disabled={disabled}>
                {saving ? <LoaderCircle className="is-spinning" size={16} /> : <Save size={16} />}
                {saving ? '正在保存' : '保存本机设置'}
              </button>
            </footer>
          </form>
        </div>

        <div className="aq-runtime-settings__disclaimer">
          当前为未签名阶段测试版；不会静默下载模型、修改外部 ComfyUI 或在卸载时删除用户项目。
        </div>
      </section>
    </div>
  )
}
