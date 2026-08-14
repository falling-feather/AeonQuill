import { assertGenerationPlan, assertStoryProject, StoryContractError } from './storyProject.mjs'

export const STORY_EXECUTION_SCHEMA_VERSION = 1
export const STORY_EXECUTION_CONFIRMATION_SCHEMA_VERSION = 1
export const MANAGED_FRAME_ASSET_SCHEMA_VERSION = 1

export const STORY_EXECUTION_LIMITS = Object.freeze({
  maxItems: 24,
  maxAssetBindings: 48,
  maxPromptCharacters: 8_000,
  maxAssetPayloadCharacters: 28_000_000,
})

export const CONTROLLED_H3_WORKFLOW_IDS = Object.freeze({
  textToVideo: 'aeonquill.video.minimax-h3-t2v.v1',
  imageToVideo: 'aeonquill.video.minimax-h3-i2v.v1',
})

export const CONTROLLED_H3_WORKFLOW_VERSION = 'h3-turbo-v2'

const EXECUTION_REQUEST_KEYS = new Set(['schemaVersion', 'selections'])
const SELECTION_KEYS = new Set([
  'shotId', 'mode', 'frameMode', 'preset', 'audio', 'firstFrameBindingId', 'lastFrameBindingId',
])
const RUNTIME_KEYS = new Set([
  'bridgeAvailable', 'connected', 'ready', 'lifecycleState', 'lifecyclePolicy', 'vramTotalBytes',
  'missingNodes', 'missingModels', 'message',
])
const ASSET_KEYS = new Set([
  'schemaVersion', 'bindingId', 'assetVersionId', 'role', 'mimeType', 'status',
])
const CHECKLIST_KEYS = new Set([
  'schemaVersion', 'id', 'projectId', 'projectRevision', 'planId', 'createdAt', 'runtime', 'items', 'digest',
])
const ITEM_KEYS = new Set([
  'id', 'ordinal', 'planTaskId', 'sceneId', 'shotId', 'label', 'mode', 'frameMode', 'workflowId',
  'status', 'blocks', 'assetBindings', 'request',
])
const BLOCK_KEYS = new Set(['code', 'message'])
const ITEM_ASSET_KEYS = new Set(['firstFrame', 'lastFrame'])
const ITEM_REQUEST_KEYS = new Set([
  'mode', 'prompt', 'aspectRatio', 'duration', 'preset', 'seed', 'audio', 'director',
])
const DIRECTOR_KEYS = new Set(['camera', 'motion', 'continuity', 'soundscape', 'constraints'])
const CONFIRMATION_KEYS = new Set([
  'schemaVersion', 'checklistId', 'checklistDigest', 'confirmedAt', 'confirmedItemIds', 'digest',
])
const CONFIRMATION_OPTIONS_KEYS = new Set(['itemIds', 'now'])
const CREATE_OPTIONS_KEYS = new Set(['now', 'runtime', 'assets'])
const PAYLOAD_KEYS = new Set(['bindingId', 'assetVersionId', 'dataUrl'])

const VIDEO_MODES = new Set(['text-to-video', 'image-to-video'])
const FRAME_MODES = new Set(['none', 'first', 'first-last'])
const PRESETS = new Set(['fast', 'balanced', 'delivery720', 'nativeHigh'])
const ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1'])
const CAMERA_MOVEMENTS = new Set(['locked', 'push-in', 'pan', 'orbit', 'follow'])
const MOTION_LEVELS = new Set(['subtle', 'natural', 'dynamic'])
const LIFECYCLE_STATES = new Set(['stopped', 'starting', 'ready', 'external', 'stopping', 'error', 'unknown'])
const LIFECYCLE_POLICIES = new Set(['persistent', 'idle', 'manual'])
const ASSET_ROLES = new Set(['first-frame', 'last-frame'])
const ASSET_STATUSES = new Set(['ready', 'missing'])
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const ITEM_STATUSES = new Set(['ready', 'blocked'])
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,199}$/
const CONTENT_ADDRESSED_ASSET_VERSION_PATTERN = /^sha256:([a-f0-9]{64})$/
const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/]+=*)$/

const MINIMUM_VRAM_GB = Object.freeze({
  fast: 8,
  balanced: 8,
  delivery720: 8,
  nativeHigh: 12,
})

function fail(code, message, details) {
  throw new StoryContractError(code, message, details)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail('INVALID_OBJECT', `${path} must be an object`)
}

function assertExactKeys(value, allowed, path) {
  assertRecord(value, path)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) fail('UNKNOWN_FIELD', `${path} contains unsupported fields: ${unknown.join(', ')}`, { fields: unknown })
  const missing = [...allowed].filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (missing.length) fail('MISSING_FIELD', `${path} is missing required fields: ${missing.join(', ')}`, { fields: missing })
}

function assertString(value, path, maxLength = 240) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_STRING', `${path} must be a non-empty string`)
  if (value.length > maxLength) fail('STRING_TOO_LONG', `${path} exceeds ${maxLength} characters`)
}

function assertNullableString(value, path, maxLength = 240) {
  if (value === null) return
  assertString(value, path, maxLength)
}

function assertSafeId(value, path) {
  assertString(value, path, 200)
  if (!SAFE_ID_PATTERN.test(value)) fail('INVALID_ID', `${path} must be a managed identifier, not a URL or file path`)
}

function assertInteger(value, path, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${path} must be an integer from ${min} to ${max}`)
  }
}

function assertNullableInteger(value, path) {
  if (value !== null) assertInteger(value, path, 0)
}

function assertStringArray(value, path, maxItems = 128, maxLength = 240) {
  if (!Array.isArray(value) || value.length > maxItems) fail('INVALID_ARRAY', `${path} must contain at most ${maxItems} items`)
  value.forEach((item, index) => assertString(item, `${path}[${index}]`, maxLength))
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount))
}

function sha256Bytes(bytes) {
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const buffer = new Uint8Array(paddedLength)
  buffer.set(bytes)
  buffer[bytes.length] = 0x80
  const view = new DataView(buffer.buffer)
  const bitLengthHigh = Math.floor(bitLength / 0x1_0000_0000)
  const bitLengthLow = bitLength >>> 0
  view.setUint32(paddedLength - 8, bitLengthHigh)
  view.setUint32(paddedLength - 4, bitLengthLow)

  const initial = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const state = [...initial]
  const words = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]
      const previous2 = words[index - 2]
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3)
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10)
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choose + constants[index] + words[index]) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0
    state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0
    state[7] = (state[7] + h) >>> 0
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('')
}

function sha256(value) {
  return sha256Bytes(new TextEncoder().encode(value))
}

function stableId(prefix, ...parts) {
  return `${prefix}-${sha256(parts.join('\u001f')).slice(0, 20)}`
}

function clone(value) {
  return structuredClone(value)
}

function workflowIdForMode(mode) {
  return mode === 'text-to-video'
    ? CONTROLLED_H3_WORKFLOW_IDS.textToVideo
    : CONTROLLED_H3_WORKFLOW_IDS.imageToVideo
}

function durationBucket(durationSeconds) {
  if (durationSeconds <= 5) return 5
  if (durationSeconds <= 10) return 10
  return 15
}

function directorMotion(cameraMovement) {
  if (cameraMovement === 'locked') return 'subtle'
  if (cameraMovement === 'orbit' || cameraMovement === 'follow') return 'dynamic'
  return 'natural'
}

function deterministicPrompt(project, scene, shot) {
  const characters = shot.characterIds
    .map((id) => project.characters.find((character) => character.id === id)?.name)
    .filter(Boolean)
  const dialogue = shot.dialogue.map(({ speaker, text }) => `${speaker}: ${text}`).join(' ')
  return [
    scene.heading,
    shot.action,
    characters.length ? `Characters: ${characters.join(', ')}.` : '',
    dialogue ? `Dialogue: ${dialogue}` : '',
    `Camera: ${shot.camera.framing}, ${shot.camera.movement}.`,
    shot.continuityNotes,
  ].filter(Boolean).join(' ').slice(0, STORY_EXECUTION_LIMITS.maxPromptCharacters)
}

function block(code, message) {
  return { code, message }
}

function runtimeBlocks(runtime, preset) {
  const blocks = []
  if (!runtime.bridgeAvailable) {
    return [block('BRIDGE_UNAVAILABLE', runtime.message || '本地桥接服务不可用，无法进入统一 Job 队列。')]
  }
  if (runtime.lifecycleState === 'error') {
    blocks.push(block('RUNTIME_ERROR', runtime.message || 'ComfyUI 生命周期管理器处于错误状态。'))
  }
  if (runtime.lifecycleState === 'starting' || runtime.lifecycleState === 'stopping') {
    blocks.push(block('RUNTIME_TRANSITION', `ComfyUI 正在${runtime.lifecycleState === 'starting' ? '启动' : '停止'}，请等待状态稳定。`))
  }
  if (!runtime.connected && runtime.lifecyclePolicy === 'manual') {
    blocks.push(block('RUNTIME_MANUAL_STOPPED', '当前为手动策略且 ComfyUI 未运行，请先启动运行时。'))
  }
  if (!runtime.connected && runtime.lifecyclePolicy === null) {
    blocks.push(block('RUNTIME_POLICY_UNKNOWN', '无法确认 ComfyUI 的按需启动策略。'))
  }
  if (runtime.connected && !runtime.ready) {
    if (runtime.missingNodes.length) {
      blocks.push(block('MISSING_NODES', `缺少 H3 必需节点：${runtime.missingNodes.join('、')}`))
    }
    if (runtime.missingModels.length) {
      blocks.push(block('MISSING_MODELS', `缺少 H3 必需模型：${runtime.missingModels.join('、')}`))
    }
    if (!runtime.missingNodes.length && !runtime.missingModels.length) {
      blocks.push(block('RUNTIME_NOT_READY', runtime.message || 'ComfyUI 已连接，但 H3 契约尚未通过。'))
    }
  }
  const minimumBytes = MINIMUM_VRAM_GB[preset] * 1024 ** 3
  if (runtime.vramTotalBytes === null || runtime.vramTotalBytes === 0) {
    blocks.push(block('VRAM_UNVERIFIED', `尚未取得显存容量；${preset} 预设至少需要 ${MINIMUM_VRAM_GB[preset]}GB。`))
  } else if (runtime.vramTotalBytes < minimumBytes) {
    const actualGb = (runtime.vramTotalBytes / 1024 ** 3).toFixed(1)
    blocks.push(block('VRAM_INSUFFICIENT', `${preset} 预设至少需要 ${MINIMUM_VRAM_GB[preset]}GB 显存，当前检测到 ${actualGb}GB。`))
  }
  return blocks
}

export function createExecutionRuntimeSnapshot(status, options = {}) {
  const bridgeAvailable = options.bridgeAvailable !== false && isRecord(status)
  const lifecycle = isRecord(status?.lifecycle) ? status.lifecycle : null
  const normalizeBytes = (value) => Number.isSafeInteger(value) && value > 0 ? value : null
  return assertExecutionRuntimeSnapshot({
    bridgeAvailable,
    connected: bridgeAvailable && status.connected === true,
    ready: bridgeAvailable && status.ready === true,
    lifecycleState: LIFECYCLE_STATES.has(lifecycle?.state) ? lifecycle.state : 'unknown',
    lifecyclePolicy: LIFECYCLE_POLICIES.has(lifecycle?.policy) ? lifecycle.policy : null,
    vramTotalBytes: normalizeBytes(status?.vramTotal),
    missingNodes: Array.isArray(status?.missingNodes) ? status.missingNodes.map(String).slice(0, 128) : [],
    missingModels: Array.isArray(status?.missingModels) ? status.missingModels.map(String).slice(0, 128) : [],
    message: typeof status?.message === 'string' && status.message.trim() ? status.message.slice(0, 500) : null,
  })
}

export function assertExecutionRuntimeSnapshot(runtime) {
  assertExactKeys(runtime, RUNTIME_KEYS, 'runtime')
  if (typeof runtime.bridgeAvailable !== 'boolean') fail('INVALID_BOOLEAN', 'runtime.bridgeAvailable must be boolean')
  if (typeof runtime.connected !== 'boolean') fail('INVALID_BOOLEAN', 'runtime.connected must be boolean')
  if (typeof runtime.ready !== 'boolean') fail('INVALID_BOOLEAN', 'runtime.ready must be boolean')
  if (!LIFECYCLE_STATES.has(runtime.lifecycleState)) fail('INVALID_RUNTIME_STATE', 'runtime.lifecycleState is unsupported')
  if (runtime.lifecyclePolicy !== null && !LIFECYCLE_POLICIES.has(runtime.lifecyclePolicy)) {
    fail('INVALID_RUNTIME_POLICY', 'runtime.lifecyclePolicy is unsupported')
  }
  assertNullableInteger(runtime.vramTotalBytes, 'runtime.vramTotalBytes')
  assertStringArray(runtime.missingNodes, 'runtime.missingNodes', 128)
  assertStringArray(runtime.missingModels, 'runtime.missingModels', 128)
  assertNullableString(runtime.message, 'runtime.message', 500)
  if (!runtime.bridgeAvailable && (runtime.connected || runtime.ready)) {
    fail('INVALID_RUNTIME_STATE', 'an unavailable bridge cannot be connected or ready')
  }
  if (runtime.ready && !runtime.connected) fail('INVALID_RUNTIME_STATE', 'a ready runtime must be connected')
  return runtime
}

export function assertManagedFrameAsset(asset) {
  assertExactKeys(asset, ASSET_KEYS, 'asset')
  if (asset.schemaVersion !== MANAGED_FRAME_ASSET_SCHEMA_VERSION) fail('UNSUPPORTED_ASSET_VERSION', 'unsupported frame asset schema')
  assertSafeId(asset.bindingId, 'asset.bindingId')
  assertSafeId(asset.assetVersionId, 'asset.assetVersionId')
  if (!ASSET_ROLES.has(asset.role)) fail('INVALID_ASSET_ROLE', 'asset.role is unsupported')
  if (!IMAGE_MIME_TYPES.has(asset.mimeType)) fail('INVALID_ASSET_MIME', 'asset.mimeType is unsupported')
  if (!ASSET_STATUSES.has(asset.status)) fail('INVALID_ASSET_STATUS', 'asset.status is unsupported')
  if (asset.status === 'ready' && !CONTENT_ADDRESSED_ASSET_VERSION_PATTERN.test(asset.assetVersionId)) {
    fail('INVALID_ASSET_VERSION_ID', 'ready frame assetVersionId must use sha256:<64 lowercase hex> content addressing')
  }
  return asset
}

export function assertVideoExecutionSelectionRequest(request) {
  assertExactKeys(request, EXECUTION_REQUEST_KEYS, 'executionRequest')
  if (request.schemaVersion !== STORY_EXECUTION_SCHEMA_VERSION) fail('UNSUPPORTED_EXECUTION_VERSION', 'unsupported execution request schema')
  if (!Array.isArray(request.selections) || !request.selections.length || request.selections.length > STORY_EXECUTION_LIMITS.maxItems) {
    fail('EXECUTION_ITEM_LIMIT', `executionRequest.selections must contain 1-${STORY_EXECUTION_LIMITS.maxItems} items`)
  }
  const shotIds = new Set()
  request.selections.forEach((selection, index) => {
    const path = `executionRequest.selections[${index}]`
    assertExactKeys(selection, SELECTION_KEYS, path)
    assertSafeId(selection.shotId, `${path}.shotId`)
    if (shotIds.has(selection.shotId)) fail('DUPLICATE_SHOT', `shot ${selection.shotId} is selected more than once`)
    shotIds.add(selection.shotId)
    if (!VIDEO_MODES.has(selection.mode)) fail('INVALID_VIDEO_MODE', `${path}.mode is unsupported`)
    if (!FRAME_MODES.has(selection.frameMode)) fail('INVALID_FRAME_MODE', `${path}.frameMode is unsupported`)
    if (!PRESETS.has(selection.preset)) fail('INVALID_VIDEO_PRESET', `${path}.preset is unsupported`)
    if (typeof selection.audio !== 'boolean') fail('INVALID_BOOLEAN', `${path}.audio must be boolean`)
    assertNullableString(selection.firstFrameBindingId, `${path}.firstFrameBindingId`, 200)
    assertNullableString(selection.lastFrameBindingId, `${path}.lastFrameBindingId`, 200)
    if (selection.firstFrameBindingId !== null) assertSafeId(selection.firstFrameBindingId, `${path}.firstFrameBindingId`)
    if (selection.lastFrameBindingId !== null) assertSafeId(selection.lastFrameBindingId, `${path}.lastFrameBindingId`)
    if (selection.mode === 'text-to-video') {
      if (selection.frameMode !== 'none') fail('INVALID_FRAME_MODE', 'text-to-video requires frameMode none')
      if (selection.firstFrameBindingId !== null || selection.lastFrameBindingId !== null) {
        fail('UNEXPECTED_FRAME_BINDING', 'text-to-video cannot declare frame bindings')
      }
    } else {
      if (!['first', 'first-last'].includes(selection.frameMode)) fail('INVALID_FRAME_MODE', 'image-to-video requires first or first-last')
      if (selection.frameMode === 'first' && selection.lastFrameBindingId !== null) {
        fail('UNEXPECTED_FRAME_BINDING', 'first-frame mode cannot declare a last-frame binding')
      }
    }
  })
  return request
}

function findAsset(bindingId, expectedRole, assetById, blocks, missingCode, missingMessage) {
  if (bindingId === null) {
    blocks.push(block(missingCode, missingMessage))
    return null
  }
  const asset = assetById.get(bindingId)
  if (!asset) {
    blocks.push(block('ASSET_BINDING_UNKNOWN', `资产绑定 ${bindingId} 不存在或不在本次受管资产清单中。`))
    return null
  }
  if (asset.role !== expectedRole) {
    blocks.push(block('ASSET_ROLE_MISMATCH', `资产 ${bindingId} 不能作为${expectedRole === 'first-frame' ? '首帧' : '末帧'}。`))
  }
  if (asset.status !== 'ready') {
    blocks.push(block('ASSET_NOT_READY', `资产 ${bindingId} 尚未完成或不可读取。`))
  }
  return clone(asset)
}

function executionItemId(projectId, projectRevision, planId, item) {
  return stableId(
    'exec', projectId, projectRevision, planId, item.planTaskId, item.mode, item.frameMode, item.request.preset,
    item.assetBindings.firstFrame?.assetVersionId ?? 'none',
    item.assetBindings.lastFrame?.assetVersionId ?? 'none',
  )
}

function checklistId(projectId, projectRevision, planId, itemIds) {
  return stableId('checklist', projectId, projectRevision, planId, ...itemIds)
}

function checklistDigest(checklist) {
  const { digest: _digest, ...payload } = checklist
  return sha256(canonicalJson(payload))
}

function confirmationDigest(confirmation) {
  const { digest: _digest, ...payload } = confirmation
  return sha256(canonicalJson(payload))
}

export function createVideoExecutionChecklist(project, plan, request, options) {
  assertStoryProject(project)
  assertGenerationPlan(plan, project)
  assertVideoExecutionSelectionRequest(request)
  assertExactKeys(options, CREATE_OPTIONS_KEYS, 'executionOptions')
  assertInteger(options.now, 'executionOptions.now', 0)
  const runtime = clone(assertExecutionRuntimeSnapshot(options.runtime))
  if (!Array.isArray(options.assets) || options.assets.length > STORY_EXECUTION_LIMITS.maxAssetBindings) {
    fail('ASSET_BINDING_LIMIT', `executionOptions.assets must contain at most ${STORY_EXECUTION_LIMITS.maxAssetBindings} items`)
  }
  const assets = options.assets.map((asset) => clone(assertManagedFrameAsset(asset)))
  const assetById = new Map()
  for (const asset of assets) {
    if (assetById.has(asset.bindingId)) fail('DUPLICATE_ASSET_BINDING', `duplicate asset binding: ${asset.bindingId}`)
    assetById.set(asset.bindingId, asset)
  }

  const shotContexts = new Map()
  project.scenes.forEach((scene) => scene.shots.forEach((shot) => {
    shotContexts.set(shot.id, { scene, shot, order: scene.ordinal * 1_000 + shot.ordinal })
  }))
  const videoTaskByShot = new Map(plan.tasks
    .filter((task) => task.kind === 'shot-video')
    .map((task) => [task.inputs.shotId, task]))
  const selections = [...request.selections].sort((left, right) => {
    const leftOrder = shotContexts.get(left.shotId)?.order ?? Number.MAX_SAFE_INTEGER
    const rightOrder = shotContexts.get(right.shotId)?.order ?? Number.MAX_SAFE_INTEGER
    return leftOrder - rightOrder || left.shotId.localeCompare(right.shotId)
  })

  const draftItems = selections.map((selection, index) => {
    const context = shotContexts.get(selection.shotId)
    if (!context) fail('UNKNOWN_SHOT', `execution selection references unknown shot ${selection.shotId}`)
    const planTask = videoTaskByShot.get(selection.shotId)
    if (!planTask) fail('MISSING_VIDEO_TASK', `generation plan has no video task for shot ${selection.shotId}`)
    const blocks = runtimeBlocks(runtime, selection.preset)
    let firstFrame = null
    let lastFrame = null
    if (selection.mode === 'image-to-video') {
      firstFrame = findAsset(
        selection.firstFrameBindingId,
        'first-frame',
        assetById,
        blocks,
        'FIRST_FRAME_REQUIRED',
        '图生视频需要受管首帧资产，当前没有可提交的首帧。',
      )
      if (selection.frameMode === 'first-last') {
        lastFrame = findAsset(
          selection.lastFrameBindingId,
          'last-frame',
          assetById,
          blocks,
          'LAST_FRAME_REQUIRED',
          '当前选择首尾帧约束，必须提供受管末帧资产。',
        )
      }
    }
    const requestPayload = {
      mode: selection.mode,
      prompt: deterministicPrompt(project, context.scene, context.shot),
      aspectRatio: project.settings.aspectRatio,
      duration: durationBucket(context.shot.durationSeconds),
      preset: selection.preset,
      seed: planTask.inputs.seed,
      audio: selection.audio,
      director: {
        camera: context.shot.camera.movement,
        motion: directorMotion(context.shot.camera.movement),
        continuity: true,
        soundscape: selection.audio ? `${context.scene.heading} 的自然环境声与对白同步` : '',
        constraints: `Avoid: ${planTask.inputs.negativePrompt}`.slice(0, 800),
      },
    }
    const item = {
      id: '',
      ordinal: index + 1,
      planTaskId: planTask.id,
      sceneId: context.scene.id,
      shotId: context.shot.id,
      label: `${context.scene.heading} · ${context.shot.title}`.slice(0, 240),
      mode: selection.mode,
      frameMode: selection.frameMode,
      workflowId: workflowIdForMode(selection.mode),
      status: blocks.length ? 'blocked' : 'ready',
      blocks,
      assetBindings: { firstFrame, lastFrame },
      request: requestPayload,
    }
    item.id = executionItemId(project.id, project.revision, plan.id, item)
    return item
  })

  const checklist = {
    schemaVersion: STORY_EXECUTION_SCHEMA_VERSION,
    id: checklistId(project.id, project.revision, plan.id, draftItems.map(({ id }) => id)),
    projectId: project.id,
    projectRevision: project.revision,
    planId: plan.id,
    createdAt: options.now,
    runtime,
    items: draftItems,
    digest: '',
  }
  checklist.digest = checklistDigest(checklist)
  return assertVideoExecutionChecklist(checklist, project, plan)
}

function assertItemRequest(request, path) {
  assertExactKeys(request, ITEM_REQUEST_KEYS, path)
  if (!VIDEO_MODES.has(request.mode)) fail('INVALID_VIDEO_MODE', `${path}.mode is unsupported`)
  assertString(request.prompt, `${path}.prompt`, STORY_EXECUTION_LIMITS.maxPromptCharacters)
  if (!ASPECT_RATIOS.has(request.aspectRatio)) fail('INVALID_ASPECT_RATIO', `${path}.aspectRatio is unsupported`)
  if (![5, 10, 15].includes(request.duration)) fail('INVALID_DURATION', `${path}.duration is unsupported`)
  if (!PRESETS.has(request.preset)) fail('INVALID_VIDEO_PRESET', `${path}.preset is unsupported`)
  assertInteger(request.seed, `${path}.seed`, 0, Number.MAX_SAFE_INTEGER)
  if (typeof request.audio !== 'boolean') fail('INVALID_BOOLEAN', `${path}.audio must be boolean`)
  assertExactKeys(request.director, DIRECTOR_KEYS, `${path}.director`)
  if (!CAMERA_MOVEMENTS.has(request.director.camera)) fail('INVALID_CAMERA', `${path}.director.camera is unsupported`)
  if (!MOTION_LEVELS.has(request.director.motion)) fail('INVALID_MOTION', `${path}.director.motion is unsupported`)
  if (typeof request.director.continuity !== 'boolean') fail('INVALID_BOOLEAN', `${path}.director.continuity must be boolean`)
  if (typeof request.director.soundscape !== 'string' || request.director.soundscape.length > 800) {
    fail('INVALID_STRING', `${path}.director.soundscape must be a string up to 800 characters`)
  }
  if (typeof request.director.constraints !== 'string' || request.director.constraints.length > 800) {
    fail('INVALID_STRING', `${path}.director.constraints must be a string up to 800 characters`)
  }
}

function assertItemAsset(asset, path, role) {
  if (asset === null) return
  assertManagedFrameAsset(asset)
  if (asset.role !== role) fail('ASSET_ROLE_MISMATCH', `${path}.role does not match its slot`)
}

export function assertVideoExecutionChecklist(checklist, project = undefined, plan = undefined) {
  assertExactKeys(checklist, CHECKLIST_KEYS, 'checklist')
  if (checklist.schemaVersion !== STORY_EXECUTION_SCHEMA_VERSION) fail('UNSUPPORTED_EXECUTION_VERSION', 'unsupported checklist schema')
  assertSafeId(checklist.id, 'checklist.id')
  assertSafeId(checklist.projectId, 'checklist.projectId')
  assertInteger(checklist.projectRevision, 'checklist.projectRevision', 0)
  assertSafeId(checklist.planId, 'checklist.planId')
  assertInteger(checklist.createdAt, 'checklist.createdAt', 0)
  assertExecutionRuntimeSnapshot(checklist.runtime)
  if (!Array.isArray(checklist.items) || !checklist.items.length || checklist.items.length > STORY_EXECUTION_LIMITS.maxItems) {
    fail('EXECUTION_ITEM_LIMIT', `checklist.items must contain 1-${STORY_EXECUTION_LIMITS.maxItems} items`)
  }
  if (project) {
    assertStoryProject(project)
    if (checklist.projectId !== project.id || checklist.projectRevision !== project.revision) {
      fail('PROJECT_CHECKLIST_MISMATCH', 'checklist does not target the supplied project revision')
    }
  }
  if (plan) {
    if (!project) fail('PROJECT_REQUIRED', 'project is required when validating checklist against a plan')
    assertGenerationPlan(plan, project)
    if (checklist.planId !== plan.id) fail('PLAN_CHECKLIST_MISMATCH', 'checklist does not target the supplied plan')
  }
  const taskById = plan ? new Map(plan.tasks.map((task) => [task.id, task])) : null
  const shotContext = project ? new Map(project.scenes.flatMap((scene) => scene.shots.map((shot) => [shot.id, { scene, shot }]))) : null
  const ids = new Set()
  checklist.items.forEach((item, index) => {
    const path = `checklist.items[${index}]`
    assertExactKeys(item, ITEM_KEYS, path)
    assertSafeId(item.id, `${path}.id`)
    if (ids.has(item.id)) fail('DUPLICATE_ID', `duplicate checklist item id ${item.id}`)
    ids.add(item.id)
    assertInteger(item.ordinal, `${path}.ordinal`, 1, STORY_EXECUTION_LIMITS.maxItems)
    if (item.ordinal !== index + 1) fail('INVALID_ORDINAL', `${path}.ordinal must match its position`)
    assertSafeId(item.planTaskId, `${path}.planTaskId`)
    assertSafeId(item.sceneId, `${path}.sceneId`)
    assertSafeId(item.shotId, `${path}.shotId`)
    assertString(item.label, `${path}.label`, 240)
    if (!VIDEO_MODES.has(item.mode)) fail('INVALID_VIDEO_MODE', `${path}.mode is unsupported`)
    if (!FRAME_MODES.has(item.frameMode)) fail('INVALID_FRAME_MODE', `${path}.frameMode is unsupported`)
    if (item.workflowId !== workflowIdForMode(item.mode)) fail('UNCONTROLLED_WORKFLOW', `${path}.workflowId is not allowed`)
    if (!ITEM_STATUSES.has(item.status)) fail('INVALID_EXECUTION_STATUS', `${path}.status is unsupported`)
    if (!Array.isArray(item.blocks) || item.blocks.length > 32) fail('INVALID_BLOCKS', `${path}.blocks is invalid`)
    item.blocks.forEach((reason, reasonIndex) => {
      const reasonPath = `${path}.blocks[${reasonIndex}]`
      assertExactKeys(reason, BLOCK_KEYS, reasonPath)
      assertString(reason.code, `${reasonPath}.code`, 80)
      assertString(reason.message, `${reasonPath}.message`, 1_000)
    })
    if ((item.blocks.length === 0) !== (item.status === 'ready')) {
      fail('INVALID_EXECUTION_STATUS', `${path}.status must reflect blocking reasons`)
    }
    assertExactKeys(item.assetBindings, ITEM_ASSET_KEYS, `${path}.assetBindings`)
    assertItemAsset(item.assetBindings.firstFrame, `${path}.assetBindings.firstFrame`, 'first-frame')
    assertItemAsset(item.assetBindings.lastFrame, `${path}.assetBindings.lastFrame`, 'last-frame')
    assertItemRequest(item.request, `${path}.request`)
    if (item.request.mode !== item.mode) fail('MODE_MISMATCH', `${path}.request.mode does not match item.mode`)
    if (item.mode === 'text-to-video') {
      if (item.frameMode !== 'none' || item.assetBindings.firstFrame || item.assetBindings.lastFrame) {
        fail('UNEXPECTED_FRAME_BINDING', `${path} text-to-video item contains frame constraints`)
      }
    } else {
      if (!['first', 'first-last'].includes(item.frameMode)) fail('INVALID_FRAME_MODE', `${path} image-to-video frameMode is invalid`)
      if (item.status === 'ready' && !item.assetBindings.firstFrame) fail('FIRST_FRAME_REQUIRED', `${path} ready item has no first frame`)
      if (item.frameMode === 'first' && item.assetBindings.lastFrame) fail('UNEXPECTED_FRAME_BINDING', `${path} first mode has a last frame`)
      if (item.frameMode === 'first-last' && item.status === 'ready' && !item.assetBindings.lastFrame) {
        fail('LAST_FRAME_REQUIRED', `${path} ready first-last item has no last frame`)
      }
    }
    const expectedId = executionItemId(checklist.projectId, checklist.projectRevision, checklist.planId, item)
    if (item.id !== expectedId) fail('ITEM_ID_MISMATCH', `${path}.id does not match its immutable inputs`)
    if (taskById) {
      const task = taskById.get(item.planTaskId)
      if (!task || task.kind !== 'shot-video' || task.inputs.shotId !== item.shotId) {
        fail('TASK_CHECKLIST_MISMATCH', `${path}.planTaskId is not the controlled shot video task`)
      }
      if (task.inputs.seed !== item.request.seed) fail('TASK_CHECKLIST_MISMATCH', `${path}.request.seed differs from the plan`)
    }
    if (shotContext) {
      const context = shotContext.get(item.shotId)
      if (!context || context.scene.id !== item.sceneId) fail('SHOT_CHECKLIST_MISMATCH', `${path} references an invalid scene/shot pair`)
      if (project.settings.aspectRatio !== item.request.aspectRatio) fail('SHOT_CHECKLIST_MISMATCH', `${path}.request.aspectRatio differs from project settings`)
    }
  })
  const expectedChecklistId = checklistId(
    checklist.projectId,
    checklist.projectRevision,
    checklist.planId,
    checklist.items.map(({ id }) => id),
  )
  if (checklist.id !== expectedChecklistId) fail('CHECKLIST_ID_MISMATCH', 'checklist.id does not match its immutable items')
  assertString(checklist.digest, 'checklist.digest', 64)
  if (!/^[a-f0-9]{64}$/.test(checklist.digest) || checklist.digest !== checklistDigest(checklist)) {
    fail('CHECKLIST_TAMPERED', 'checklist digest does not match its contents')
  }
  return checklist
}

export function createVideoExecutionConfirmation(checklist, options) {
  assertVideoExecutionChecklist(checklist)
  assertExactKeys(options, CONFIRMATION_OPTIONS_KEYS, 'confirmationOptions')
  assertInteger(options.now, 'confirmationOptions.now', 0)
  assertStringArray(options.itemIds, 'confirmationOptions.itemIds', STORY_EXECUTION_LIMITS.maxItems, 200)
  if (!options.itemIds.length) fail('EMPTY_CONFIRMATION', 'at least one ready checklist item must be confirmed')
  const confirmedItemIds = [...new Set(options.itemIds)]
  if (confirmedItemIds.length !== options.itemIds.length) fail('DUPLICATE_ID', 'confirmation contains duplicate item ids')
  const itemById = new Map(checklist.items.map((item) => [item.id, item]))
  confirmedItemIds.forEach((itemId) => {
    const item = itemById.get(itemId)
    if (!item) fail('UNKNOWN_EXECUTION_ITEM', `confirmation references unknown item ${itemId}`)
    if (item.status !== 'ready') fail('BLOCKED_EXECUTION_ITEM', `item ${itemId} is blocked and cannot be confirmed`)
  })
  const confirmation = {
    schemaVersion: STORY_EXECUTION_CONFIRMATION_SCHEMA_VERSION,
    checklistId: checklist.id,
    checklistDigest: checklist.digest,
    confirmedAt: options.now,
    confirmedItemIds,
    digest: '',
  }
  confirmation.digest = confirmationDigest(confirmation)
  return assertVideoExecutionConfirmation(confirmation, checklist)
}

export function assertVideoExecutionConfirmation(confirmation, checklist) {
  assertVideoExecutionChecklist(checklist)
  assertExactKeys(confirmation, CONFIRMATION_KEYS, 'confirmation')
  if (confirmation.schemaVersion !== STORY_EXECUTION_CONFIRMATION_SCHEMA_VERSION) {
    fail('UNSUPPORTED_CONFIRMATION_VERSION', 'unsupported execution confirmation schema')
  }
  assertSafeId(confirmation.checklistId, 'confirmation.checklistId')
  assertString(confirmation.checklistDigest, 'confirmation.checklistDigest', 64)
  assertInteger(confirmation.confirmedAt, 'confirmation.confirmedAt', 0)
  assertStringArray(confirmation.confirmedItemIds, 'confirmation.confirmedItemIds', STORY_EXECUTION_LIMITS.maxItems, 200)
  if (!confirmation.confirmedItemIds.length) fail('EMPTY_CONFIRMATION', 'confirmation must include at least one item')
  if (new Set(confirmation.confirmedItemIds).size !== confirmation.confirmedItemIds.length) {
    fail('DUPLICATE_ID', 'confirmation contains duplicate item ids')
  }
  if (confirmation.checklistId !== checklist.id || confirmation.checklistDigest !== checklist.digest) {
    fail('STALE_CONFIRMATION', 'confirmation no longer matches this checklist')
  }
  const itemById = new Map(checklist.items.map((item) => [item.id, item]))
  confirmation.confirmedItemIds.forEach((itemId) => {
    const item = itemById.get(itemId)
    if (!item) fail('UNKNOWN_EXECUTION_ITEM', `confirmation references unknown item ${itemId}`)
    if (item.status !== 'ready') fail('BLOCKED_EXECUTION_ITEM', `item ${itemId} is blocked and cannot execute`)
  })
  assertString(confirmation.digest, 'confirmation.digest', 64)
  if (!/^[a-f0-9]{64}$/.test(confirmation.digest) || confirmation.digest !== confirmationDigest(confirmation)) {
    fail('CONFIRMATION_TAMPERED', 'confirmation digest does not match its contents')
  }
  return confirmation
}

function assertAssetPayload(payload, index) {
  const path = `assetPayloads[${index}]`
  assertExactKeys(payload, PAYLOAD_KEYS, path)
  assertSafeId(payload.bindingId, `${path}.bindingId`)
  assertSafeId(payload.assetVersionId, `${path}.assetVersionId`)
  if (typeof payload.dataUrl !== 'string' || payload.dataUrl.length > STORY_EXECUTION_LIMITS.maxAssetPayloadCharacters) {
    fail('INVALID_ASSET_PAYLOAD', `${path}.dataUrl is invalid or too large`)
  }
  const match = DATA_URL_PATTERN.exec(payload.dataUrl)
  if (!match) fail('INVALID_ASSET_PAYLOAD', `${path}.dataUrl must be a PNG, JPEG, or WebP data URL`)
  const expectedDigest = CONTENT_ADDRESSED_ASSET_VERSION_PATTERN.exec(payload.assetVersionId)?.[1]
  if (!expectedDigest) {
    fail('INVALID_ASSET_VERSION_ID', `${path}.assetVersionId must use sha256:<64 lowercase hex> content addressing`)
  }
  let decoded
  try {
    decoded = globalThis.atob(match[2])
  } catch {
    fail('INVALID_ASSET_PAYLOAD', `${path}.dataUrl contains invalid base64 data`)
  }
  const bytes = new Uint8Array(decoded.length)
  for (let offset = 0; offset < decoded.length; offset += 1) bytes[offset] = decoded.charCodeAt(offset)
  if (sha256Bytes(bytes) !== expectedDigest) {
    fail('ASSET_PAYLOAD_CONTENT_MISMATCH', `${path}.dataUrl bytes do not match its assetVersionId`)
  }
  return match[1]
}

export function compileConfirmedVideoRequests(checklist, confirmation, assetPayloads = []) {
  assertVideoExecutionConfirmation(confirmation, checklist)
  if (!Array.isArray(assetPayloads) || assetPayloads.length > STORY_EXECUTION_LIMITS.maxAssetBindings) {
    fail('ASSET_BINDING_LIMIT', `assetPayloads must contain at most ${STORY_EXECUTION_LIMITS.maxAssetBindings} items`)
  }
  const payloadByBinding = new Map()
  assetPayloads.forEach((payload, index) => {
    const mimeType = assertAssetPayload(payload, index)
    if (payloadByBinding.has(payload.bindingId)) fail('DUPLICATE_ASSET_BINDING', `duplicate asset payload ${payload.bindingId}`)
    payloadByBinding.set(payload.bindingId, { ...payload, mimeType })
  })
  const itemById = new Map(checklist.items.map((item) => [item.id, item]))
  const usedPayloads = new Set()
  const submissions = confirmation.confirmedItemIds.map((itemId) => {
    const item = itemById.get(itemId)
    const request = clone(item.request)
    if (item.mode === 'image-to-video') {
      const firstBinding = item.assetBindings.firstFrame
      const firstPayload = firstBinding ? payloadByBinding.get(firstBinding.bindingId) : null
      if (!firstBinding || !firstPayload) fail('FIRST_FRAME_PAYLOAD_REQUIRED', `item ${item.id} has no first-frame payload`)
      if (firstPayload.assetVersionId !== firstBinding.assetVersionId || firstPayload.mimeType !== firstBinding.mimeType) {
        fail('ASSET_PAYLOAD_MISMATCH', `first-frame payload for item ${item.id} differs from the confirmed asset version`)
      }
      request.sourceImageDataUrl = firstPayload.dataUrl
      usedPayloads.add(firstBinding.bindingId)
      const lastBinding = item.assetBindings.lastFrame
      if (lastBinding) {
        const lastPayload = payloadByBinding.get(lastBinding.bindingId)
        if (!lastPayload) fail('LAST_FRAME_PAYLOAD_REQUIRED', `item ${item.id} has no last-frame payload`)
        if (lastPayload.assetVersionId !== lastBinding.assetVersionId || lastPayload.mimeType !== lastBinding.mimeType) {
          fail('ASSET_PAYLOAD_MISMATCH', `last-frame payload for item ${item.id} differs from the confirmed asset version`)
        }
        request.lastFrameImageDataUrl = lastPayload.dataUrl
        usedPayloads.add(lastBinding.bindingId)
      }
    }
    return {
      schemaVersion: STORY_EXECUTION_SCHEMA_VERSION,
      itemId: item.id,
      workflowId: item.workflowId,
      idempotencyKey: `story-${sha256(`${confirmation.digest}\u001f${item.id}`).slice(0, 48)}`,
      request,
    }
  })
  const unused = [...payloadByBinding.keys()].filter((bindingId) => !usedPayloads.has(bindingId))
  if (unused.length) fail('UNUSED_ASSET_PAYLOAD', `unconfirmed asset payloads were supplied: ${unused.join(', ')}`)
  return submissions
}
