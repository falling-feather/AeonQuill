import { FormEvent, useState } from 'react'
import { ArrowUpRight, Sparkles } from 'lucide-react'

type PromptBarProps = {
  onSubmit: (prompt: string) => void
}

const suggestions = ['把选中图片像素化', '为选中图片去背景', '把元件排列整齐']

export function PromptBar({ onSubmit }: PromptBarProps) {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const prompt = value.trim()
    if (!prompt) return
    onSubmit(prompt)
    setValue('')
  }

  return (
    <div className="prompt-dock" data-ui-overlay>
      {focused && !value ? (
        <div className="prompt-suggestions" aria-label="快捷指令">
          {suggestions.map((suggestion) => (
            <button type="button" key={suggestion} onPointerDown={(e) => e.preventDefault()} onClick={() => setValue(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      <form className="prompt-bar" onSubmit={submit}>
        <Sparkles size={19} strokeWidth={1.7} aria-hidden="true" />
        <input
          value={value}
          aria-label="画布快捷指令"
          placeholder="描述操作，例如“把选中图片像素化”…"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="prompt-submit" disabled={!value.trim()}>
          执行 <ArrowUpRight size={16} strokeWidth={1.8} />
        </button>
      </form>
    </div>
  )
}
