import { lazy } from 'react'
import type { ProductModeId } from './modeRegistry'

const balancedWorkbenchLoader = () => import('../App')
const pixelWorkbenchLoader = () => import('../modes/pixel/PixelModeWorkbench')
  .then(({ PixelModeWorkbench }) => ({ default: PixelModeWorkbench }))
const smartVideoWorkbenchLoader = () => import('../modes/video/SmartVideoWorkbench')
  .then(({ SmartVideoWorkbench }) => ({ default: SmartVideoWorkbench }))

const assetLibraryDialogLoader = () => import('../components/Library/AssetLibraryDialog')
  .then(({ AssetLibraryDialog }) => ({ default: AssetLibraryDialog }))
const workflowCenterDialogLoader = () => import('../components/WorkflowCenter/WorkflowCenterDialog')
  .then(({ WorkflowCenterDialog }) => ({ default: WorkflowCenterDialog }))
const runtimeSettingsDialogLoader = () => import('../components/Home/RuntimeSettingsDialog')
  .then(({ RuntimeSettingsDialog }) => ({ default: RuntimeSettingsDialog }))
const projectRecoveryDialogLoader = () => import('../components/Home/ProjectRecoveryDialog')
  .then(({ ProjectRecoveryDialog }) => ({ default: ProjectRecoveryDialog }))

const modeLoaders = {
  balanced: balancedWorkbenchLoader,
  pixel: pixelWorkbenchLoader,
  'smart-video': smartVideoWorkbenchLoader,
} satisfies Record<ProductModeId, () => Promise<unknown>>

const dialogLoaders = {
  library: assetLibraryDialogLoader,
  workflow: workflowCenterDialogLoader,
  settings: runtimeSettingsDialogLoader,
  recovery: projectRecoveryDialogLoader,
} as const

export type DeferredProductDialog = keyof typeof dialogLoaders

export const LazyBalancedWorkbench = lazy(balancedWorkbenchLoader)
export const LazyPixelModeWorkbench = lazy(pixelWorkbenchLoader)
export const LazySmartVideoWorkbench = lazy(smartVideoWorkbenchLoader)
export const LazyAssetLibraryDialog = lazy(assetLibraryDialogLoader)
export const LazyWorkflowCenterDialog = lazy(workflowCenterDialogLoader)
export const LazyRuntimeSettingsDialog = lazy(runtimeSettingsDialogLoader)
export const LazyProjectRecoveryDialog = lazy(projectRecoveryDialogLoader)

export function preloadProductMode(modeId: ProductModeId) {
  return modeLoaders[modeId]().then(() => undefined)
}

export function preloadProductDialog(dialog: DeferredProductDialog) {
  return dialogLoaders[dialog]().then(() => undefined)
}
