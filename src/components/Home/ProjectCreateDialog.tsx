import { Blend, ChevronRight, Clapperboard, Grid3X3, ImagePlus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ProjectCreateInput } from '../../shell/contracts'
import type { ProductModeId } from '../../shell/modeRegistry'

const MODES: Array<{ id: ProductModeId; title: string; description: string; icon: typeof Blend }> = [
  { id: 'balanced', title: '均衡模式', description: '图像、文字与多模态创作', icon: Blend },
  { id: 'pixel', title: '像素模式', description: '精细像素绘制与动画', icon: Grid3X3 },
  { id: 'smart-video', title: '智能视频', description: '从灵感或剧本开始制片', icon: Clapperboard },
]

const COLORS: ProjectCreateInput['color'][] = ['ink', 'amber', 'sage', 'blue', 'violet', 'rose']

interface ProjectCreateDialogProps {
  open: boolean
  initialModeId: ProductModeId
  onClose: () => void
  onCreate: (input: ProjectCreateInput) => void
}

export function ProjectCreateDialog({ open, initialModeId, onClose, onCreate }: ProjectCreateDialogProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [modeId, setModeId] = useState<ProductModeId>(initialModeId)
  const [color, setColor] = useState<ProjectCreateInput['color']>('amber')
  const titleRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (!open) return
    setModeId(initialModeId)
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus())
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => !element.hasAttribute('hidden'))
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKey)
    }
  }, [initialModeId, onClose, open])

  if (!open) return null

  return (
    <div className="aq-project-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <form
        ref={dialogRef}
        className="aq-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="aq-project-dialog-title"
        onSubmit={(event) => {
          event.preventDefault()
          const normalizedTitle = title.trim()
          if (!normalizedTitle) return
          onCreate({ title: normalizedTitle, description: description.trim(), initialModeId: modeId, color })
          setTitle('')
          setDescription('')
        }}
      >
        <header>
          <div>
            <h2 id="aq-project-dialog-title">创建新项目</h2>
            <p>先选择入口，项目建立后仍可使用全部三种创作模式。</p>
          </div>
          <button type="button" className="aq-project-dialog__close" aria-label="关闭创建项目" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="aq-project-dialog__body">
          <label className="aq-project-field">
            <span>项目名称 <em>*</em></span>
            <input ref={titleRef} value={title} maxLength={120} placeholder="输入项目名称" onChange={(event) => setTitle(event.target.value)} />
          </label>

          <label className="aq-project-field">
            <span>项目描述 <small>可选</small></span>
            <textarea value={description} maxLength={600} placeholder="记录目标、风格或交付内容，稍后仍可修改。" onChange={(event) => setDescription(event.target.value)} />
            <small className="aq-project-field__counter">{description.length}/600</small>
          </label>

          <fieldset className="aq-project-modes">
            <legend>初始模式 <em>*</em></legend>
            <p>仅决定第一份文档；不会限制项目后续能力。</p>
            <div>
              {MODES.map((mode) => {
                const Icon = mode.icon
                return (
                  <button key={mode.id} type="button" className={`aq-project-mode-option is-${mode.id} ${modeId === mode.id ? 'is-selected' : ''}`} aria-pressed={modeId === mode.id} onClick={() => setModeId(mode.id)}>
                    <Icon size={24} strokeWidth={1.55} aria-hidden="true" />
                    <strong>{mode.title}</strong>
                    <span>{mode.description}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>

          <fieldset className="aq-project-colors">
            <legend>项目封面与主题色</legend>
            <div>
              <button type="button" className="aq-project-cover-upload" aria-label="自定义项目封面（后续版本）" disabled><ImagePlus size={18} /></button>
              {COLORS.map((item) => (
                <button key={item} type="button" className={`aq-project-color is-${item} ${color === item ? 'is-selected' : ''}`} aria-label={`选择${item}主题色`} aria-pressed={color === item} onClick={() => setColor(item)} />
              ))}
            </div>
          </fieldset>

          <details className="aq-project-advanced">
            <summary><ChevronRight size={15} /> 高级选项</summary>
            <p>当前原型将项目目录保存在本机用户数据，并为每份模式文档建立独立引用；可配置项目根目录将在 P0 后续版本接入。</p>
          </details>
        </div>

        <footer>
          <button type="button" className="aq-project-cancel" onClick={onClose}>取消</button>
          <button type="submit" className="aq-project-create" disabled={!title.trim()}>创建并进入</button>
        </footer>
      </form>
    </div>
  )
}
