import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { SurfaceState } from '../components/Home'

interface ModeErrorBoundaryProps {
  children: ReactNode
  modeLabel: string
  resetKey: string
  onBack: () => void
}

interface ModeErrorBoundaryState {
  failed: boolean
  retryKey: number
}

export class ModeErrorBoundary extends Component<ModeErrorBoundaryProps, ModeErrorBoundaryState> {
  state: ModeErrorBoundaryState = { failed: false, retryKey: 0 }

  static getDerivedStateFromError(): Partial<ModeErrorBoundaryState> {
    return { failed: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The user receives an actionable fallback; no sensitive error details are rendered.
  }

  componentDidUpdate(previousProps: ModeErrorBoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  private retry = () => {
    this.setState(({ retryKey }) => ({ failed: false, retryKey: retryKey + 1 }))
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="aq-product-state-host">
          <SurfaceState
            feedback={{
              status: 'error',
              title: `${this.props.modeLabel}未能完成初始化`,
              detail: '工作台遇到未预期的界面错误。可以重新挂载当前模式；若仍失败，请返回主页检查本机状态。',
              actionLabel: '重试当前模式',
              secondaryActionLabel: '返回主页',
            }}
            focusOnMount
            onAction={this.retry}
            onSecondaryAction={this.props.onBack}
          />
        </div>
      )
    }

    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>
  }
}
