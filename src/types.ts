export type ElementKind =
  | 'poster'
  | 'pixel'
  | 'note'
  | 'palette'
  | 'text'
  | 'shape'
  | 'frame'
  | 'image'
  | 'video'
  | 'connector'

export type ImageToolId =
  | 'adjust'
  | 'crop'
  | 'remove-background'
  | 'element-extract'
  | 'region-adjust'
  | 'mask-refine'
  | 'pixelate'
  | 'upscale'
  | 'sharpen'
  | 'alpha-cleanup'
  | 'more'

export type ImageLabMode = Exclude<ImageToolId, 'more'>

export type ToolId =
  | 'select'
  | 'frame'
  | 'text'
  | 'note'
  | 'shape'
  | 'image'
  | 'pixel'
  | 'pan'

export type Camera = {
  x: number
  y: number
  zoom: number
}

export type ImageAdjustments = {
  brightness: number
  contrast: number
  saturation: number
}

export type CropSettings = {
  aspect: '1:1' | '4:3' | '3:4' | '16:9'
  zoom: number
  positionX: number
  positionY: number
}

export type MaskBrushMode = 'remove' | 'restore'

export type MaskPoint = {
  x: number
  y: number
}

export type MaskStroke = {
  id: string
  mode: MaskBrushMode
  size: number
  hardness: number
  points: MaskPoint[]
}

export type MaskRecipe = {
  schemaVersion: 1
  strokes: MaskStroke[]
}

export type MaskDraft = {
  recipe: MaskRecipe
  previewUrl: string
  width: number
  height: number
  changedPercent: number
}

export type ProcessingStep = {
  id: string
  type: ImageLabMode | ImageOperationId
  label: string
  detail: string
  enabled: boolean
  createdAt: number
  outputSrc?: string
  maskRecipe?: MaskRecipe
}

export type ImageOperationId =
  | 'upscale-lanczos'
  | 'pixelate'
  | 'sharpen'
  | 'alpha-cleanup'
  | 'masked-adjust'
  | 'remove-background'
  | 'upscale-realesrgan'
  | 'semantic-element-extract'

export type ImageToolCapability = {
  id: ImageOperationId
  label: string
  category: 'upscale' | 'pixel' | 'enhance' | 'cleanup' | 'segmentation' | 'masked-edit'
  provider: string
  deterministic: boolean
  available: boolean
  unavailableReason?: string
  models?: string[]
  params: Record<string, unknown>
}

export type ImageToolManifest = {
  version: string
  checkedAt: number
  limits: {
    maxInputBytes: number
    maxInputPixels: number
    maxOutputPixels: number
  }
  operations: ImageToolCapability[]
}

export type SemanticPoint = {
  x: number
  y: number
}

export type SemanticWorkflowStatus =
  | 'ready'
  | 'runtime-stopped'
  | 'missing-dependency'
  | 'node-mismatch'
  | 'template-pending'

export type SemanticWorkflowCapability = {
  id: 'element-extract' | 'region-edit' | 'point-edit' | 'portrait-adjust'
  operation?: ImageOperationId
  version: string
  label: string
  description: string
  maturity: 'preview' | 'experimental' | 'planned'
  implemented: boolean
  available: boolean
  installed: boolean
  status: SemanticWorkflowStatus
  message: string
  missingExtensions: string[]
  missingArtifacts: string[]
  missingNodes: string[]
  resources: {
    class: 'cpu' | 'gpu'
    minVramGb: number
    recommendedVramGb: number
    timeoutSeconds: number
  }
  inputs: Record<string, unknown>
  outputs: string[]
}

export type SemanticWorkflowManifest = {
  version: string
  checkedAt: number
  runtime: {
    connected: boolean
    lifecycle: string
    device?: string
    vramTotal: number
  }
  workflows: SemanticWorkflowCapability[]
}

export type SemanticElementExtractRequest = {
  workflowId: 'element-extract'
  sourceImageDataUrl: string
  sourceElementId?: string
  params: {
    positivePoints: SemanticPoint[]
    negativePoints: SemanticPoint[]
    threshold: number
  }
}

export type ImageJobRequest = {
  operation: ImageOperationId
  sourceImageDataUrl: string
  maskImageDataUrl?: string
  sourceElementId?: string
  params: Record<string, unknown>
}

export type StoredImageJobRequest = Omit<ImageJobRequest, 'sourceImageDataUrl' | 'maskImageDataUrl'> & {
  maskProvided?: boolean
}

export type VideoGenerationMode = 'text-to-video' | 'image-to-video'

export type VideoJobPhase =
  | 'queued'
  | 'preparing'
  | 'processing'
  | 'conditioning'
  | 'sampling'
  | 'decoding'
  | 'encoding'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ProcessingJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export type ProcessingJobError = {
  code: string
  title: string
  message: string
  suggestions?: string[]
  details?: Record<string, unknown>
}

export type ProcessingJobLog = {
  at: number
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
}

export type ProcessingJobScheduling = {
  schemaVersion: 1
  resourceClass: 'cpu' | 'gpu' | string
  priority: number
  timeoutMs: number
  idempotencyKey: string
  attempt: number
  maxAttempts: number
  queuedAt: number
  recoveredAt?: number
  startedAt?: number
  deadlineAt?: number
  finishedAt?: number
}

export type ProcessingJobCostEvent = {
  id: string
  at: number
  type: 'estimate' | 'usage' | 'adjustment'
  source: string
  unit: string
  quantity: number
  amountMicros: number
  currency: string
  billable: boolean
}

export type ProcessingJobOutputVersion = {
  id: string
  logicalAssetId: string
  version: number
  assetId: string
  sourceElementId?: string
  mimeType: string
  bytes: number
  provenance: Record<string, unknown>
}

export type VideoJobRequest = {
  mode: VideoGenerationMode
  prompt: string
  aspectRatio: '16:9' | '9:16' | '1:1'
  duration: 5 | 10 | 15
  preset: 'fast' | 'balanced' | 'delivery720' | 'nativeHigh'
  seed: number
  audio: boolean
  sourceElementId?: string
  sourceImageDataUrl?: string
  lastFrameImageDataUrl?: string
  director?: {
    camera: 'locked' | 'push-in' | 'pan' | 'orbit' | 'follow'
    motion: 'subtle' | 'natural' | 'dynamic'
    continuity: boolean
    soundscape: string
    constraints: string
  }
}

export type ProcessingJob = {
  id: string
  kind?: 'image' | 'video'
  tool: ImageLabMode | ImageOperationId | VideoGenerationMode
  label: string
  status: ProcessingJobStatus
  phase?: VideoJobPhase
  progress: number
  detail: string
  createdAt: number
  updatedAt?: number
  completedAt?: number
  workflowVersion?: string
  retryOf?: string
  scheduling?: ProcessingJobScheduling
  costEvents?: ProcessingJobCostEvent[]
  workflowMetadata?:
    | {
        dimensions: { width: number; height: number }
        frames: number
        fps: number
        steps: number
        lowVram: boolean
        audio: boolean
      }
    | {
        version: string
        positivePoints: number
        negativePoints: number
        threshold: number
      }
  request?:
    | (Omit<VideoJobRequest, 'sourceImageDataUrl' | 'lastFrameImageDataUrl'> & { hasLastFrame?: boolean })
    | StoredImageJobRequest
  sourceElementId?: string
  comfyPromptId?: string
  sampleStep?: number
  sampleSteps?: number
  outputUrl?: string
  maskUrl?: string
  outputVersion?: ProcessingJobOutputVersion
  output?:
    | {
        filename: string
        maskFilename?: string
        width: number
        height: number
        mimeType: string
        bytes: number
        provider: string
      }
    | {
        filename: string
        subfolder: string
        type: string
      }
  error?: ProcessingJobError
  logs?: ProcessingJobLog[]
}

export type ImageJobOutput = Extract<NonNullable<ProcessingJob['output']>, { width: number }>

export function isImageJobOutput(
  output: ProcessingJob['output'],
): output is ImageJobOutput {
  return Boolean(output && 'width' in output && 'height' in output && 'provider' in output)
}

export type RuntimeStatus = {
  connected: boolean
  ready: boolean
  comfyVersion?: string
  pythonVersion?: string
  device?: string
  vramTotal?: number
  vramFree?: number
  queueRunning: number
  queuePending: number
  missingNodes?: string[]
  missingModels?: string[]
  message?: string
  checkedAt?: number
  lifecycle?: {
    policy: 'persistent' | 'idle' | 'manual'
    state: 'stopped' | 'starting' | 'ready' | 'external' | 'stopping' | 'error'
    owned: boolean
    canAutoStop: boolean
    idleTimeoutMs: number
    idleShutdownAt?: number | null
    startedAt?: number | null
    lastError?: string | null
  }
}

export type RuntimeDiagnosticIssue = {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
  action: string
}

export type RuntimeDiagnostics = {
  schemaVersion: 1
  checkedAt: number
  product: {
    name: string
    service: 'aeonquill-local-runtime'
    platform: string
    architecture: string
    node: string
  }
  storage: {
    scope: 'development' | 'user-data' | 'legacy-user-data' | 'custom'
    runtimeWritable: boolean
    dataWritable: boolean
    cacheWritable: boolean
    logsWritable: boolean
    configWritable: boolean
    runtimeLabel: string
    configLabel?: string
    projectsManaged: boolean
    uninstallPreservesUserData: boolean
    legacyDataLayout: boolean
  }
  configuration: {
    fileValid: boolean
    rootConfigured: boolean
    pythonConfigured: boolean
    rootValid: boolean
    pythonValid: boolean
    rootLabel?: string
    pythonLabel?: string
    comfyUrl: string
    launchPolicy: 'persistent' | 'idle' | 'manual'
    idleSeconds: number
    restartRequired: boolean
    legacyEnvironment: boolean
  }
  capabilities: {
    bridge: { status: 'ready'; label: string }
    image: {
      status: 'ready' | 'unavailable'
      available: number
      total: number
      operations: Array<{
        id: ImageOperationId
        label: string
        provider: string
        available: boolean
        unavailableReason?: string
      }>
    }
    comfyui: {
      status: 'ready' | 'incomplete' | 'sleeping' | 'needs-configuration'
      configured: boolean
      connected: boolean
      ready: boolean
      lifecycle: string
      device?: string
      vramTotal: number
      missingNodes: number
      missingModels: number
    }
    semantic: {
      installed: number
      total: number
      ready: number
    }
  }
  logs: {
    managed: boolean
    label: string
    comfyLogAvailable: boolean
  }
  issues: RuntimeDiagnosticIssue[]
}

export type RuntimeConfigurationRequest =
  | { mode: 'auto-discover' }
  | {
      mode: 'manual'
      comfyRoot?: string | null
      pythonPath?: string | null
      comfyUrl?: string
      comfyLaunchPolicy?: 'persistent' | 'idle' | 'manual'
      comfyIdleSeconds?: number
    }

export type RuntimeConfigurationResult = {
  saved: true
  restartRequired: boolean
  message: string
  recoveredInvalidConfig?: boolean
  diagnostics: RuntimeDiagnostics
}

export type PixelDraft = {
  width: number
  height: number
  pixels: string[]
  palette: string[]
  previewUrl: string
}

export type CanvasElement = {
  id: string
  kind: ElementKind
  name: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  radius: number
  fill: string
  stroke: string
  strokeWidth?: number
  content?: string
  src?: string
  videoSrc?: string
  posterSrc?: string
  jobId?: string
  jobStatus?: ProcessingJobStatus
  jobPhase?: VideoJobPhase
  jobProgress?: number
  jobDetail?: string
  jobError?: ProcessingJobError
  sourceSrc?: string
  naturalWidth?: number
  naturalHeight?: number
  assetId?: string
  assetVersion?: number
  assetVersionId?: string
  sourceElementId?: string
  adjustments?: ImageAdjustments
  crop?: CropSettings
  processingStack?: ProcessingStep[]
  pixels?: string[]
  palette?: string[]
  pixelWidth?: number
  pixelHeight?: number
  fromId?: string
  toId?: string
  locked: boolean
  visible: boolean
  zIndex: number
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
