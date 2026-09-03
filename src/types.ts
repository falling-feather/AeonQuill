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
  | 'region-edit'
  | 'point-edit'
  | 'portrait-adjust'
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

export type MaskMorphology = {
  expand: number
  feather: number
  trim: number
}

export type MaskRecipe = {
  schemaVersion: 1
  strokes: MaskStroke[]
} | {
  schemaVersion: 2
  strokes: MaskStroke[]
  morphology: MaskMorphology
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
  | 'semantic-region-edit'
  | 'semantic-point-edit'
  | 'semantic-portrait-adjust'

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

export type SemanticRegionEditRequest = {
  workflowId: 'region-edit'
  projectId: string
  sourceImageDataUrl: string
  maskImageDataUrl: string
  sourceElementId?: string
  title?: string
  params: {
    instruction: string
    seed: number
    maskChannel: 'alpha' | 'luma'
  }
}

export type SemanticPointEditRequest = {
  workflowId: 'point-edit'
  projectId: string
  sourceImageDataUrl: string
  sourceElementId?: string
  title?: string
  params: {
    positivePoints: SemanticPoint[]
    negativePoints: SemanticPoint[]
    threshold: number
    instruction: string
    seed: number
  }
}

export type SemanticPortraitAdjustRequest = {
  workflowId: 'portrait-adjust'
  projectId: string
  sourceImageDataUrl: string
  sourceElementId?: string
  title?: string
  params: {
    instruction: string
    identityStrength: number
    seed: number
  }
}

export type SemanticImageRequest =
  | SemanticElementExtractRequest
  | SemanticRegionEditRequest
  | SemanticPointEditRequest
  | SemanticPortraitAdjustRequest

export type StoredSemanticImageJobRequest = {
  operation:
    | 'semantic-element-extract'
    | 'semantic-region-edit'
    | 'semantic-point-edit'
    | 'semantic-portrait-adjust'
  workflowId: SemanticImageRequest['workflowId']
  workflowVersion: string
  projectId?: string
  sourceAssetId?: string
  sourceContentHash?: string
  maskAssetId?: string
  maskContentHash?: string
  title?: string
  sourceElementId?: string
  params: Record<string, unknown>
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
export type H3ScenarioId = 'auto' | 'cinematic' | 'shortDrama' | 'product' | 'portrait' | 'illustration'

export type VideoJobPhase =
  | 'queued'
  | 'preparing'
  | 'processing'
  | 'conditioning'
  | 'sampling'
  | 'decoding'
  | 'encoding'
  | 'restoring'
  | 'saving'
  | 'validating'
  | 'cleaning'
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

export type JobArchiveSummary = {
  schemaVersion: 1
  revision: number
  total: number
  byStatus: { completed: number; failed: number; cancelled: number }
  oldestArchivedAt: number | null
  newestArchivedAt: number | null
}

export type VideoJobRequest = {
  mode: VideoGenerationMode
  prompt: string
  scenario?: H3ScenarioId
  aspectRatio: '16:9' | '9:16' | '1:1'
  duration: 5 | 10 | 15
  preset: 'fast' | 'balanced' | 'delivery720' | 'nativeHigh' | 'cinemaBase' | 'master720'
  modelProfile?: 'auto' | 'fp8Scaled4060' | 'int8ConvrotCu130'
  seed: number
  audio: boolean
  sourceElementId?: string
  sourceImageDataUrl?: string
  lastFrameImageDataUrl?: string
  candidateBinding?: import('./lib/story/localVideoCandidate.mjs').LocalVideoCandidateJobBinding
  director?: {
    camera: 'locked' | 'push-in' | 'pan' | 'orbit' | 'follow'
    motion: 'subtle' | 'natural' | 'dynamic'
    continuity: boolean
    soundscape: string
    music?: string
    constraints: string
  }
}

export type FinalCutJobRequest = {
  sourceJobIds: string[]
  projectId?: string
  soundRenderJobId?: string
  title: string
  transitionSeconds: number
  width: 1280
  height: 720
  fps: 24 | 25 | 30
}

type SoundRenderJobIdentity = {
  projectId: string
  documentId: string
  productionRevision: number
  soundTimelineRevision: number
  title: string
}

export type SoundRenderJobRequest = SoundRenderJobIdentity & (
  | {
      action: 'prepare-speech'
      format: 'mp3' | 'wav'
      speechBudgetUsd: number
    }
  | {
      action: 'render-mix'
    }
)

export type VideoChainShotRequest = Omit<
  VideoJobRequest,
  'sourceImageDataUrl' | 'lastFrameImageDataUrl' | 'mode' | 'duration' | 'candidateBinding'
> & {
  executionItemId: string
  candidateTarget?: import('./lib/story/localVideoCandidate.mjs').LocalVideoCandidateTarget
  mode?: VideoGenerationMode
  duration?: 5
}

export type VideoChainJobRequest = {
  projectId: string
  title: string
  shots: VideoChainShotRequest[]
  transitionSeconds: number
  width: 1280
  height: 720
  fps: 24 | 25 | 30
}

export type CustomWorkflowJobRequest = {
  customWorkflowId: string
  projectId: string
  title: string
  prompt: string
  negativePrompt?: string
  sourceLibraryItemId?: string
  lastFrameLibraryItemId?: string
  seed?: number
  width?: number
  height?: number
  frames?: number
  steps?: number
}

export type StorageRetentionDays = {
  terminalInputs: number
  intermediateOutputs: number
  previewCache: number
  comfyResiduals: number
  projectOrphans: number
}

export type StoragePolicy = {
  schemaVersion: 1
  revision: number
  updatedAt: number
  preserveDeliveries: true
  retentionDays: StorageRetentionDays
  projectOverrides: Record<string, Partial<StorageRetentionDays>>
}

export type StorageCandidate = {
  id: string
  category: string
  kind: 'project-asset' | 'managed-file'
  bytes: number
  ageDays: number
  projectId?: string
  jobId?: string
  label: string
  reason: string
}

export type StorageCategory = {
  id: string
  label: string
  cleanable: boolean
  bytes: number
  files: number
  candidateBytes: number
  candidateFiles: number
  protectedFiles: number
  missingFiles: number
  scanErrors: number
  truncated: boolean
  roots: Array<{
    id: string
    label: string
    category?: string
    bytes: number
    files: number
    exists: boolean
    shared?: boolean
    referenceCount?: number
    removalMode?: 'runtime-removal-check-only'
    removalBlocked?: boolean
    deletionMode?: 'manual-only'
    skippedLinks?: number
    excludedFiles?: number
  }>
}

export type StorageScan = {
  version: string
  scanId: string
  fingerprint: string
  scannedAt: number
  expiresAt: number
  projectId?: string
  policy: StoragePolicy
  policyIssue?: { code: string; message: string } | null
  capacity: {
    totalBytes: number
    freeBytes: number
    reserveBytes: number
    usableBytes: number
    status: 'healthy' | 'warning' | 'critical'
  }
  estimates: Array<{ id: string; label: string; requiredBytes: number; available: boolean }>
  totals: { bytes: number; files: number; candidateBytes: number; candidateFiles: number }
  references: { projectAssets: number; jobAssets: number; recoveryPoints: number }
  categories: StorageCategory[]
  candidates: StorageCandidate[]
  safety: {
    modelsRequireRuntimeRemovalCheck: true
    customOutputManualOnly: boolean
    deliveriesPreserved: true
    symlinksFollowed: false
  }
}

export type StorageCleanupRequest = {
  scanId: string
  fingerprint: string
  candidateIds: string[]
  acknowledgedBytes: number
}

export type StorageCleanupResult = {
  version: string
  scanId: string
  selectedFiles: number
  acknowledgedBytes: number
  reclaimedBytes: number
  removed: string[]
  skipped: Array<{ id: string; code: string }>
  failures: Array<{ id: string; code: string; message: string }>
  verification: {
    scanId: string
    scannedAt: number
    candidateBytes: number
    candidateFiles: number
    selectedStillCandidates: string[]
    consistent: boolean
  }
}

export type ProcessingJob = {
  id: string
  kind?: 'image' | 'video' | 'custom-workflow' | 'provider-video' | 'sound-render' | 'final-cut' | 'video-chain' | 'storage-cleanup'
  tool: ImageLabMode | ImageOperationId | VideoGenerationMode | 'custom-comfy-workflow' | 'byok-video' | 'sound-render' | 'final-cut' | 'video-chain' | 'storage-lifecycle'
  label: string
  status: ProcessingJobStatus
  phase?: VideoJobPhase
  progress: number
  detail: string
  createdAt: number
  updatedAt?: number
  completedAt?: number
  archiveMetadata?: {
    schemaVersion: 1
    archivedAt: number
    reason: 'manual' | 'age' | 'active-limit'
  }
  workflowVersion?: string
  executionIdentity?: {
    identityHash: string
    productVersion: string
    functionalTrack: string
    sourceCommit: string | null
    runtimePackageId: string | null
    runtimeRegistryVersion: string
  } | null
  retryOf?: string
  scheduling?: ProcessingJobScheduling
  costEvents?: ProcessingJobCostEvent[]
  workflowMetadata?:
    | {
        dimensions: { width: number; height: number }
        frames: number
        fps: number
        steps: number
        samplingMode?: 'turbo' | 'base'
        sampler?: string
        lowVram: boolean
        audio: boolean
        modelProfile?: string
        modelPrecision?: string
        delivery?: string
        deliveryDimensions?: { width: number; height: number }
        preserveNative?: boolean
        qualityClass?: string
        estimatedMinutes?: string
        sourceEncoding?: string
        postprocessor?: string | null
        postprocessMetadata?: {
          version: string
          postprocessor: string
          model: string
          vae: string
          outputDimensions: { width: number; height: number }
          framesPerChunk: number
          temporalOverlap: number
          colorCorrection: string
          steps: number
          sampler: string
          scheduler: string
        }
        promptAgent?: {
          version: string
          mode: 'T2VA' | 'I2VA' | 'FL2VA'
          requestedScenario: H3ScenarioId
          resolvedScenario: Exclude<H3ScenarioId, 'auto'>
          effectiveDurationSeconds: number
          warnings: string[]
        }
      }
    | {
        version: string
        positivePoints: number
        negativePoints: number
        threshold: number
      }
    | {
        version: string
        promptVersion: string
        workflowId: 'region-edit' | 'point-edit' | 'portrait-adjust'
        model: string
        textEncoder: string
        vae: string
        steps: number
        cfg: number
        sampler: string
        scheduler: string
        seed: number
        masked: boolean
        outputNodeId: string
        identityStrength?: number
        instructionHash: string
      }
    | {
        version: string
        customWorkflowId: string
        customWorkflowTitle: string
        workflowHash: string
        mappingHash: string
        outputNodeId: string
        outputNodeType?: string
        parameterRoles: string[]
        nodeCount: number
      }
  request?:
    | (Omit<VideoJobRequest, 'sourceImageDataUrl' | 'lastFrameImageDataUrl'> & { hasLastFrame?: boolean })
    | StoredImageJobRequest
    | StoredSemanticImageJobRequest
    | CustomWorkflowJobRequest
    | SoundRenderJobRequest
    | FinalCutJobRequest
    | VideoChainJobRequest
    | StorageCleanupRequest
  sourceElementId?: string
  comfyPromptId?: string
  sampleStep?: number
  sampleSteps?: number
  outputUrl?: string
  intermediateOutputs?: Array<{
    role: 'native-source'
    label: string
    filename: string
    outputUrl: string
    dimensions: { width: number; height: number }
  }>
  maskUrl?: string
  outputVersion?: ProcessingJobOutputVersion
  libraryAsset?: Record<string, unknown>
  localCandidateBackfill?: import('./lib/story/localVideoCandidate.mjs').LocalVideoCandidateBackfill
  videoChainShot?: {
    schemaVersion: 1
    parentJobId: string
    index: number
    executionItemId: string
    requestHash: string
    candidateTarget: import('./lib/story/localVideoCandidate.mjs').LocalVideoCandidateTarget | null
    predecessorJobId: string | null
    predecessorOutputAssetId: string | null
  }
  videoChainManifest?: import('./lib/story/videoChainManifest.mjs').VideoChainManifest
  maskLibraryAsset?: Record<string, unknown>
  providerUsage?: {
    estimatedCostUsd: number
    actualCostUsd: number | null
    elapsedMs: number
  }
  soundRenderMetadata?: {
    action: 'prepare-speech' | 'render-mix'
    timelineDigest?: string
    timelineDurationMs?: number
    requestedCueCount?: number
    generatedBindings: Array<{
      cueId: string
      cueFingerprint: string
      libraryItemId: string
      libraryVersionId: string
      contentHash: string
      mimeType: 'audio/mpeg' | 'audio/wav'
      scope: 'project'
      boundAt: number
      title: string
      adapter: { providerLabel: string; model: string; profile: string; persistence: 'memory-only' }
      usage: { estimatedCostUsd: number; actualCostUsd: number | null; elapsedMs: number }
      remoteRequestId: string | null
    }>
    estimatedCostUsd?: number
    actualCostUsd?: number | null
    durationMs?: number
    cueCount?: number
    subtitleCount?: number
    inputProbes?: Array<{ duration: number; audioCodec: string; sampleRate: number; channels: number }>
    outputProbe?: { duration: number; audioCodec: string; sampleRate: number; channels: number }
    mix?: { targetLufs: number; truePeakDbtp: number; dialogueDuckingDb: number; sampleRate: 48000; channels: 2 }
    sourceAssets?: Array<{ cueId: string; contentHash: string; mimeType: string }>
    subtitles?: Record<'srt' | 'vtt' | 'ass', {
      filename: string
      url: string
      mimeType: string
      bytes: number
      sha256: string
      delivery?: { status: 'copied' | 'failed'; filename?: string; directoryLabel?: string; message?: string }
    }>
  }
  finalCutMetadata?: {
    version: string
    sourceCount: number
    sourceJobIds: string[]
    transitionSeconds: number
    expectedDuration: number
    sourceProbes: Array<{
      duration: number
      hasAudio: boolean
      width: number
      height: number
      videoCodec: string
      audioCodec: string | null
      frameRate: string
      sampleRate: number | null
      channels: number | null
    }>
    outputProbe: {
      duration: number
      hasAudio: boolean
      width: number
      height: number
      videoCodec: string
      audioCodec: string | null
      frameRate: string
      sampleRate: number | null
      channels: number | null
    }
    soundMix?: boolean
    subtitles?: boolean
    soundRenderJobId?: string
    qualityReport?: {
      schemaVersion: 1
      profileVersion: string
      evaluatedAt: number
      asset: { sha256: string; bytes: number }
      media: {
        width: number
        height: number
        durationSeconds: number
        frameRate: number
        frames: number
        videoCodec: string
        pixelFormat: string
        bitRate: number
        hasAudio: boolean
        audioCodec: string | null
        sampleRate: number | null
        channels: number | null
      }
      signals: {
        black: { count: number; totalSeconds: number; longestSeconds: number; segments: Array<{ start: number; end: number; duration: number }> }
        freeze: { count: number; totalSeconds: number; longestSeconds: number; segments: Array<{ start: number; end: number; duration: number }> }
        silence: { count: number; totalSeconds: number; longestSeconds: number; segments: Array<{ start: number; end: number; duration: number }> }
        loudness: { integratedLufs: number | null; rangeLu: number | null; truePeakDbfs: number | null }
      }
      subtitles: {
        present: boolean
        format?: 'ass'
        playResolution?: { width: number; height: number }
        cueCount?: number
        invalidTiming?: number
        unsafeMargins?: number
        outsidePositions?: number
        overlappingCues?: number
        minimumSafeMargin?: { x: number; y: number }
      }
      checks: Array<{
        id: string
        label: string
        level: 'error' | 'warning'
        status: 'pass' | 'fail' | 'not-applicable'
        actual: unknown
        expected: unknown
        message: string
      }>
      summary: {
        status: 'pass' | 'review' | 'fail'
        blockingCount: number
        reviewCount: number
        passedCount: number
        manualReviewRequired: true
        manualReviewDimensions: string[]
        statement: string
      }
    }
  }
  childJobIds?: string[]
  checkpointChildJobIds?: string[]
  activeChildJobId?: string
  finalCutJobId?: string
  delivery?: {
    status: 'copied' | 'failed'
    filename?: string
    directoryLabel?: string
    message?: string
  }
  storageLifecycle?: {
    lastCleanupAt?: number
    expiredFiles?: string[]
  }
  storageCleanup?: StorageCleanupResult
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
  pytorchVersion?: string
  systemRamTotal?: number
  systemRamFree?: number
  device?: string
  vramTotal?: number
  vramFree?: number
  queueRunning: number
  queuePending: number
  missingNodes?: string[]
  missingModels?: string[]
  videoCapabilities?: {
    modelProfiles: Array<{
      id: string
      label: string
      state: string
      modes: Record<'base' | 'turbo', {
        available: boolean
        missingNodes: string[]
        missingModels: string[]
        runtimeIssues: string[]
      }>
    }>
    postprocessors: Array<{
      id: string
      label: string
      state: string
      available: boolean
      missingNodes: string[]
      missingModels: string[]
    }>
    presets: Array<{
      id: string
      available: boolean
      availableProfiles: string[]
      postprocessor: null | {
        id: string
        available: boolean
        missingNodes: string[]
        missingModels: string[]
      }
    }>
  }
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

export type BuildIdentity = {
  version: string
  productVersion: string
  functionalTrack: string
  sourceCommit: string | null
  sourceCommitShort: string | null
  sourceState: 'commit' | 'unversioned-development'
  runtimePackageId: string | null
  runtimeRegistryVersion: string
  identityHash: string
}

export type RuntimeRegistryMigrationPreview = {
  version: string
  status: 'ready' | 'not-needed' | 'blocked'
  plans: Array<{
    id: string | null
    status: 'ready' | 'not-needed' | 'blocked'
    beforeHash: string
    afterHash: string | null
    configLabel: string
    changeCount: number
    groups: Array<{ group: string; relativeDepth: number }>
    reason: string | null
  }>
  readyCount: number
  changeCount: number
  movesModelFiles: false
  removalGate: {
    sharedRoots: Array<{
      rootId: string
      rootLabel: string
      referenceCount: number
      blocked: boolean
    }>
    blockedRoots: number
  }
  latest: null | {
    id: string
    planId: string
    status: 'applied' | 'rolled-back'
    beforeHash: string
    afterHash: string
    appliedAt: number
    rolledBackAt: number | null
    changeCount: number
    rollbackAvailable: boolean
  }
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
  identity: BuildIdentity | null
  registryMigration: RuntimeRegistryMigrationPreview | null
  storage: {
    scope: 'development' | 'user-data' | 'legacy-user-data' | 'custom'
    runtimeWritable: boolean
    dataWritable: boolean
    cacheWritable: boolean
    logsWritable: boolean
    configWritable: boolean
    outputDirectoryWritable: boolean | null
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
    outputDirectoryConfigured: boolean
    outputDirectorySource: 'custom' | 'application'
    outputDirectoryLabel?: string
    offlineRuntimePackageId: string | null
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
      outputDirectory?: string | null
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
