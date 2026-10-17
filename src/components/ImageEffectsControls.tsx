import { ArrowDown, ArrowUp, Copy, Download, Pencil, Trash2, Upload } from 'lucide-react'
import { isReplayableImageStep } from '../lib/imageEffects.mjs'
import type { CanvasElement } from '../types'

export function ImageEffectsControls({ element, busy, recipeSteps, selectedImageCount, onAction, onEdit, onCopy, onApplyRecipe, onExport, onImport, onCancel }: {
  element: CanvasElement
  busy: boolean
  recipeSteps: number
  selectedImageCount: number
  onAction: (action: 'up' | 'down' | 'toggle' | 'remove' | 'clear', stepId?: string) => void
  onEdit: (stepId: string) => void
  onCopy: () => void
  onApplyRecipe: () => void
  onExport: () => void
  onImport: (file: File) => void
  onCancel: () => void
}) {
  const steps = element.processingStack ?? []
  const disabled = busy || element.locked
  return <section className="processing-stack-section" aria-label="图像效果栈">
    <div className="inspector-section-heading"><span>效果栈 · {steps.length}</span><button type="button" disabled={disabled || !steps.length} onClick={() => onAction('clear')}>清空效果</button></div>
    <p className="aq-effects-hint">本地效果按顺序处理；生成结果是固定步骤，可开关。修改后可一次撤销。</p>
    <div className="processing-stack-list">
      {steps.map((step, index) => {
        const replayable = isReplayableImageStep(step)
        return <div className="aq-effect-row" key={step.id} data-effect-id={step.id}>
          <label className="aq-effect-title"><input type="checkbox" aria-label={`${step.enabled ? '停用' : '启用'}${step.label}`} checked={step.enabled} disabled={disabled} onChange={() => onAction('toggle', step.id)} /><span><strong>{step.label}</strong><small>{step.detail}</small><em>{replayable ? '本地参数' : step.type === 'adjust' ? '旧调整 · 编辑后可排序' : '固定结果'}</em></span></label>
          <div className="aq-effect-actions">
            <button type="button" aria-label={`上移效果 ${index + 1}`} title="上移" disabled={disabled || !replayable || !isReplayableImageStep(steps[index - 1])} onClick={() => onAction('up', step.id)}><ArrowUp size={13} /></button>
            <button type="button" aria-label={`下移效果 ${index + 1}`} title="下移" disabled={disabled || !replayable || !isReplayableImageStep(steps[index + 1])} onClick={() => onAction('down', step.id)}><ArrowDown size={13} /></button>
            <button type="button" aria-label={`编辑效果 ${index + 1}`} title="编辑参数 / 局部重做" disabled={disabled || !replayable && step.type !== 'adjust'} onClick={() => onEdit(step.id)}><Pencil size={13} /></button>
            <button type="button" aria-label={`删除效果 ${index + 1}`} title="删除效果" disabled={disabled} onClick={() => onAction('remove', step.id)}><Trash2 size={13} /></button>
          </div>
        </div>
      })}
      {!steps.length ? <p className="aq-effects-hint">通过调整、裁剪或蒙版修边添加本地效果。</p> : null}
    </div>
    <div className="aq-effect-recipes">
      <button type="button" disabled={busy || !steps.length} onClick={onCopy}><Copy size={13} />复制效果配方</button>
      <button type="button" disabled={disabled || !recipeSteps || !selectedImageCount} onClick={onApplyRecipe}>应用配方到所选 {selectedImageCount} 张</button>
      <button type="button" disabled={busy || !recipeSteps} onClick={onExport}><Download size={13} />导出配方</button>
      <label><Upload size={13} />导入配方<input type="file" className="visually-hidden" accept=".json,application/json" disabled={busy} aria-label="导入图像效果配方" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = '' }} /></label>
      {recipeSteps ? <small>当前配方 {recipeSteps} 步，只含参数和归一化蒙版。</small> : null}
    </div>
    {busy ? <p role="status">正在重放效果… <button type="button" onClick={onCancel}>取消效果处理</button></p> : null}
  </section>
}
