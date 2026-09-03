import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { SurfaceState } from '../components/Home/SurfaceState'

interface ModeErrorBoundaryProps {
  children: ReactNode
  modeLabel: string
  resetKey: string
  onBack: () => void
}

interface ModeErrorBoundaryState {
  failed: boolean
  retryKey: number
  failureKind: 'render' | 'module' | null
}

function isModuleLoadFailure(error: Error) {
  const summary = `${error.name}: ${error.message}`
  return /ChunkLoadError|Loading (?:CSS )?chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/iu.test(summary)
}

export class ModeErrorBoundary extends Component<ModeErrorBoundaryProps, ModeErrorBoundaryState> {
  state: ModeErrorBoundaryState = { failed: false, retryKey: 0, failureKind: null }

  static getDerivedStateFromError(error: Error): Partial<ModeErrorBoundaryState> {
    return { failed: true, failureKind: isModuleLoadFailure(error) ? 'module' : 'render' }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The user receives an actionable fallback; no sensitive error details are rendered.
  }

  componentDidUpdate(previousProps: ModeErrorBoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false, failureKind: null })
    }
  }

  private retry = () => {
    if (this.state.failureKind === 'module') {
      window.location.reload()
      return
    }
    this.setState(({ retryKey }) => ({ failed: false, retryKey: retryKey + 1, failureKind: null }))
  }

  render() {
    if (this.state.failed) {
      const moduleFailure = this.state.failureKind === 'module'
      return (
        <div className="aq-product-state-host">
          <SurfaceState
            feedback={{
              status: 'error',
              title: `${this.props.modeLabel}未能完成初始化`,
              detail: moduleFailure
                ? '模式模块没有完整载入。可以重新载入应用并重试；当前项目内容仍保存在本机。'
                : '工作台遇到未预期的界面错误。可以重新挂载当前模式；若仍失败，请返回主页检查本机状态。',
              actionLabel: moduleFailure ? '重新载入应用' : '重试当前模式',
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
