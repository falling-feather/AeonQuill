import type { ButtonHTMLAttributes, ReactNode } from 'react'

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  active?: boolean
  children: ReactNode
  text?: string
}

export function IconButton({
  label,
  active = false,
  children,
  text,
  className = '',
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      title={label}
      className={`icon-button ${active ? 'is-active' : ''} ${text ? 'has-text' : ''} ${className}`}
      {...props}
    >
      {children}
      {text ? <span>{text}</span> : null}
    </button>
  )
}
