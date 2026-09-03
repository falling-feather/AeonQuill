export const VIDEO_CONTINUITY_GRAPH_SCHEMA_VERSION = 2

export const VIDEO_CONTINUITY_LIMITS = Object.freeze({
  maxCharacters: 32,
  maxViews: 192,
  maxWardrobes: 384,
  maxLocations: 128,
  maxFrames: 640,
  maxShots: 320,
  maxBindingsPerShot: 32,
  maxCandidates: 2_000,
  maxCandidatesPerShot: 12,
  maxReviews: 2_000,
  maxNotes: 2_000,
})

const GRAPH_KIND = 'aeonquill.video-continuity-graph'
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const ASSET_STATUSES = new Set(['planned', 'ready', 'approved'])
const SHOT_STATUSES = new Set(['blocked', 'candidate-required', 'ready', 'approved', 'retry-required'])
const LEGACY_SHOT_STATUSES = new Set(['blocked', 'ready', 'approved', 'retry-required'])
const VIEWS = new Set(['front', 'side', 'back', 'expression', 'action'])
const FRAME_ROLES = new Set(['first-frame', 'last-frame'])
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm'])
const LIBRARY_SCOPES = new Set(['project', 'global-reference'])
const CANDIDATE_SOURCES = new Set(['comfyui-h3', 'byok-video', 'imported'])
const GENERATION_MODES = new Set(['fast', 'quality'])
const DECISIONS = new Set(['accept', 'retry'])
const REVIEW_STATUSES = new Set(['active', 'superseded'])
const SCORE_KEYS = Object.freeze(['identity', 'wardrobe', 'location', 'sharpness', 'motion'])

export class VideoContinuityError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'VideoContinuityError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new VideoContinuityError(code, message, details)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function record(value, path) {
  if (!isRecord(value)) fail('INVALID_OBJECT', `${path} must be an object`)
  return value
}

function exactKeys(value, keys, path) {
  const actual = Object.keys(value)
  const allowed = new Set(keys)
  const unknown = actual.filter((key) => !allowed.has(key))
  const missing = keys.filter((key) => !(key in value))
  if (unknown.length || missing.length) fail('INVALID_FIELDS', `${path} fields do not match the continuity schema`, { unknown, missing })
}

function safeId(value, path, nullable = false) {
  if (nullable && value === null) return value
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('INVALID_ID', `${path} must be a safe id`)
  return value
}

function text(value, path, max, nullable = false) {
  if (nullable && value === null) return value
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_STRING', `${path} must contain 1-${max} characters`)
  return value
}

function integer(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`)
  return value
}

function token(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function stableId(prefix, ...parts) {
  return `${prefix}-${token(parts.join('|'))}`
}

function normalizeAssetBinding(binding, path = 'binding') {
  const value = record(binding, path)
  exactKeys(value, ['libraryItemId', 'libraryVersionId', 'contentHash', 'mimeType', 'scope', 'boundAt'], path)
  safeId(value.libraryItemId, `${path}.libraryItemId`)
  safeId(value.libraryVersionId, `${path}.libraryVersionId`)
  if (typeof value.contentHash !== 'string' || !SHA256.test(value.contentHash)) fail('INVALID_CONTENT_HASH', `${path}.contentHash must be a lowercase SHA-256`)
  if (!MIME_TYPES.has(value.mimeType)) fail('INVALID_ASSET_MIME', `${path}.mimeType is unsupported`)
  if (!LIBRARY_SCOPES.has(value.scope)) fail('INVALID_LIBRARY_SCOPE', `${path}.scope is unsupported`)
  integer(value.boundAt, `${path}.boundAt`, 1, Number.MAX_SAFE_INTEGER)
  return value
}

export function assertContinuityAssetBinding(binding) {
  return normalizeAssetBinding(binding)
}

function normalizeVideoAssetBinding(binding, path = 'binding') {
  const value = record(binding, path)
  exactKeys(value, ['libraryItemId', 'libraryVersionId', 'contentHash', 'mimeType', 'scope', 'boundAt'], path)
  safeId(value.libraryItemId, `${path}.libraryItemId`)
  safeId(value.libraryVersionId, `${path}.libraryVersionId`)
  if (typeof value.contentHash !== 'string' || !SHA256.test(value.contentHash)) fail('INVALID_CONTENT_HASH', `${path}.contentHash must be a lowercase SHA-256`)
  if (!VIDEO_MIME_TYPES.has(value.mimeType)) fail('INVALID_VIDEO_MIME', `${path}.mimeType is unsupported`)
  if (!LIBRARY_SCOPES.has(value.scope)) fail('INVALID_LIBRARY_SCOPE', `${path}.scope is unsupported`)
  integer(value.boundAt, `${path}.boundAt`, 1, Number.MAX_SAFE_INTEGER)
  return value
}

export function assertContinuityVideoBinding(binding) {
  return normalizeVideoAssetBinding(binding)
}

function assertAssetSlot(value, path, extraKeys, extraValidation) {
  const slot = record(value, path)
  exactKeys(slot, [...extraKeys, 'status', 'asset'], path)
  if (!ASSET_STATUSES.has(slot.status)) fail('INVALID_ASSET_STATUS', `${path}.status is unsupported`)
  if (slot.asset !== null) normalizeAssetBinding(slot.asset, `${path}.asset`)
  if (slot.status === 'planned' && slot.asset !== null) fail('ASSET_STATUS_MISMATCH', `${path} planned slots cannot contain an asset`)
  if (slot.status !== 'planned' && slot.asset === null) fail('ASSET_STATUS_MISMATCH', `${path} ${slot.status} slots require an asset`)
  extraValidation(slot)
  return slot
}

function assertScore(value, path) {
  if (value === null) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 5 || Math.round(value * 10) !== value * 10) {
    fail('INVALID_SCORE', `${path} must be null or a 0-5 score with one decimal place`)
  }
}

function assertReview(value, path, shotIds, candidatesById, legacy = false) {
  const review = record(value, path)
  exactKeys(review, legacy
    ? ['id', 'shotId', 'attempt', 'reviewerId', 'scores', 'decision', 'notes', 'reasons', 'recommendedActions', 'inputFingerprint', 'status', 'createdAt']
    : ['id', 'shotId', 'candidateId', 'attempt', 'reviewerId', 'scores', 'decision', 'notes', 'reasons', 'recommendedActions', 'inputFingerprint', 'status', 'createdAt'], path)
  safeId(review.id, `${path}.id`)
  safeId(review.shotId, `${path}.shotId`)
  if (!shotIds.has(review.shotId)) fail('DANGLING_SHOT', `${path}.shotId is unknown`)
  if (!legacy) {
    safeId(review.candidateId, `${path}.candidateId`, true)
    if (review.candidateId !== null) {
      const candidate = candidatesById.get(review.candidateId)
      if (!candidate) fail('DANGLING_CANDIDATE', `${path}.candidateId is unknown`)
      if (candidate.shotId !== review.shotId) fail('CROSS_SHOT_CANDIDATE', `${path}.candidateId belongs to another shot`)
    }
    if (review.status === 'active' && review.candidateId === null) fail('ACTIVE_REVIEW_WITHOUT_CANDIDATE', `${path} active reviews require a video candidate`)
  }
  integer(review.attempt, `${path}.attempt`, 1, VIDEO_CONTINUITY_LIMITS.maxReviews)
  safeId(review.reviewerId, `${path}.reviewerId`)
  const scores = record(review.scores, `${path}.scores`)
  exactKeys(scores, SCORE_KEYS, `${path}.scores`)
  SCORE_KEYS.forEach((key) => assertScore(scores[key], `${path}.scores.${key}`))
  if (SCORE_KEYS.filter((key) => scores[key] !== null).length < 3) fail('INSUFFICIENT_REVIEW_SCORES', `${path}.scores requires at least three applicable dimensions`)
  if (!DECISIONS.has(review.decision)) fail('INVALID_REVIEW_DECISION', `${path}.decision is unsupported`)
  if (typeof review.notes !== 'string' || review.notes.length > VIDEO_CONTINUITY_LIMITS.maxNotes) fail('INVALID_REVIEW_NOTES', `${path}.notes is invalid`)
  for (const key of ['reasons', 'recommendedActions']) {
    if (!Array.isArray(review[key]) || review[key].length > 8) fail('INVALID_REVIEW_DETAILS', `${path}.${key} is invalid`)
    review[key].forEach((entry, index) => text(entry, `${path}.${key}[${index}]`, 400))
  }
  safeId(review.inputFingerprint, `${path}.inputFingerprint`)
  if (!REVIEW_STATUSES.has(review.status)) fail('INVALID_REVIEW_STATUS', `${path}.status is unsupported`)
  integer(review.createdAt, `${path}.createdAt`, 1, Number.MAX_SAFE_INTEGER)
}

function assertVideoContinuityGraphSchema(input, allowLegacy = false) {
  const graph = record(input, 'continuityGraph')
  const legacy = graph.schemaVersion === 1
  exactKeys(graph, legacy
    ? ['kind', 'schemaVersion', 'storyProjectId', 'storyRevision', 'characters', 'views', 'wardrobes', 'locations', 'frames', 'shots', 'reviews', 'revision', 'createdAt', 'updatedAt']
    : ['kind', 'schemaVersion', 'storyProjectId', 'storyRevision', 'characters', 'views', 'wardrobes', 'locations', 'frames', 'shots', 'candidates', 'reviews', 'revision', 'createdAt', 'updatedAt'], 'continuityGraph')
  if (graph.kind !== GRAPH_KIND || (graph.schemaVersion !== VIDEO_CONTINUITY_GRAPH_SCHEMA_VERSION && !(allowLegacy && legacy))) fail('UNSUPPORTED_SCHEMA', 'Unsupported video continuity graph schema')
  safeId(graph.storyProjectId, 'continuityGraph.storyProjectId', true)
  if (graph.storyRevision !== null) integer(graph.storyRevision, 'continuityGraph.storyRevision', 0, Number.MAX_SAFE_INTEGER)
  if ((graph.storyProjectId === null) !== (graph.storyRevision === null)) fail('STORY_IDENTITY_MISMATCH', 'storyProjectId and storyRevision must both be null or both be present')

  const collections = [
    ['characters', VIDEO_CONTINUITY_LIMITS.maxCharacters],
    ['views', VIDEO_CONTINUITY_LIMITS.maxViews],
    ['wardrobes', VIDEO_CONTINUITY_LIMITS.maxWardrobes],
    ['locations', VIDEO_CONTINUITY_LIMITS.maxLocations],
    ['frames', VIDEO_CONTINUITY_LIMITS.maxFrames],
    ['shots', VIDEO_CONTINUITY_LIMITS.maxShots],
    ...(!legacy ? [['candidates', VIDEO_CONTINUITY_LIMITS.maxCandidates]] : []),
    ['reviews', VIDEO_CONTINUITY_LIMITS.maxReviews],
  ]
  for (const [key, max] of collections) {
    if (!Array.isArray(graph[key]) || graph[key].length > max) fail('COLLECTION_LIMIT', `continuityGraph.${key} is invalid`)
  }

  const allIds = new Set()
  for (const key of ['characters', 'views', 'wardrobes', 'locations', 'frames', 'shots', ...(!legacy ? ['candidates'] : []), 'reviews']) {
    for (const item of graph[key]) {
      safeId(item?.id, `continuityGraph.${key}.id`)
      if (allIds.has(item.id)) fail('DUPLICATE_ID', `continuityGraph contains duplicate id ${item.id}`)
      allIds.add(item.id)
    }
  }

  const characterIds = new Set(graph.characters.map(({ id }) => id))
  const viewIds = new Set(graph.views.map(({ id }) => id))
  const wardrobeIds = new Set(graph.wardrobes.map(({ id }) => id))
  const locationIds = new Set(graph.locations.map(({ id }) => id))
  const frameIds = new Set(graph.frames.map(({ id }) => id))
  const shotIds = new Set(graph.shots.map(({ id }) => id))
  const candidatesById = new Map((legacy ? [] : graph.candidates).map((candidate) => [candidate.id, candidate]))
  const reviewIds = new Set(graph.reviews.map(({ id }) => id))

  graph.characters.forEach((inputCharacter, index) => {
    const path = `continuityGraph.characters[${index}]`
    const character = record(inputCharacter, path)
    exactKeys(character, ['id', 'storyCharacterId', 'profileId', 'name', 'identityLock', 'viewIds', 'wardrobeIds'], path)
    safeId(character.id, `${path}.id`)
    safeId(character.storyCharacterId, `${path}.storyCharacterId`, true)
    safeId(character.profileId, `${path}.profileId`)
    text(character.name, `${path}.name`, 120)
    text(character.identityLock, `${path}.identityLock`, 1_000)
    for (const [key, ids, known, max] of [
      ['viewIds', character.viewIds, viewIds, 8],
      ['wardrobeIds', character.wardrobeIds, wardrobeIds, 12],
    ]) {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > max || new Set(ids).size !== ids.length) fail('INVALID_REFERENCES', `${path}.${key} is invalid`)
      ids.forEach((itemId) => {
        if (!known.has(itemId)) fail('DANGLING_REFERENCE', `${path}.${key} contains ${itemId}`)
        const referenced = key === 'viewIds'
          ? graph.views.find(({ id }) => id === itemId)
          : graph.wardrobes.find(({ id }) => id === itemId)
        if (referenced?.characterId !== character.id) fail('CROSS_CHARACTER_REFERENCE', `${path}.${key} contains an asset owned by another character`)
      })
    }
  })
  const profileIds = graph.characters.map(({ profileId }) => profileId)
  if (new Set(profileIds).size !== profileIds.length) fail('DUPLICATE_PROFILE', 'continuityGraph.characters contains duplicate profileId values')
  const storyCharacterIds = graph.characters.map(({ storyCharacterId }) => storyCharacterId).filter(Boolean)
  if (new Set(storyCharacterIds).size !== storyCharacterIds.length) fail('DUPLICATE_STORY_CHARACTER', 'continuityGraph.characters contains duplicate storyCharacterId values')

  graph.views.forEach((inputView, index) => assertAssetSlot(inputView, `continuityGraph.views[${index}]`, ['id', 'characterId', 'profileViewId', 'view', 'required'], (view) => {
    safeId(view.id, `continuityGraph.views[${index}].id`)
    if (!characterIds.has(view.characterId)) fail('DANGLING_CHARACTER', `continuityGraph.views[${index}].characterId is unknown`)
    safeId(view.profileViewId, `continuityGraph.views[${index}].profileViewId`)
    if (!VIEWS.has(view.view)) fail('INVALID_VIEW', `continuityGraph.views[${index}].view is unsupported`)
    if (typeof view.required !== 'boolean') fail('INVALID_BOOLEAN', `continuityGraph.views[${index}].required must be boolean`)
  }))
  const profileViewIds = graph.views.map(({ profileViewId }) => profileViewId)
  if (new Set(profileViewIds).size !== profileViewIds.length) fail('DUPLICATE_PROFILE_ASSET', 'continuityGraph.views contains duplicate profileViewId values')

  graph.wardrobes.forEach((inputWardrobe, index) => assertAssetSlot(inputWardrobe, `continuityGraph.wardrobes[${index}]`, ['id', 'characterId', 'profileWardrobeId', 'label', 'trigger'], (wardrobe) => {
    safeId(wardrobe.id, `continuityGraph.wardrobes[${index}].id`)
    if (!characterIds.has(wardrobe.characterId)) fail('DANGLING_CHARACTER', `continuityGraph.wardrobes[${index}].characterId is unknown`)
    safeId(wardrobe.profileWardrobeId, `continuityGraph.wardrobes[${index}].profileWardrobeId`)
    text(wardrobe.label, `continuityGraph.wardrobes[${index}].label`, 120)
    text(wardrobe.trigger, `continuityGraph.wardrobes[${index}].trigger`, 400)
  }))
  const profileWardrobeIds = graph.wardrobes.map(({ profileWardrobeId }) => profileWardrobeId)
  if (new Set(profileWardrobeIds).size !== profileWardrobeIds.length) fail('DUPLICATE_PROFILE_ASSET', 'continuityGraph.wardrobes contains duplicate profileWardrobeId values')

  graph.locations.forEach((inputLocation, index) => assertAssetSlot(inputLocation, `continuityGraph.locations[${index}]`, ['id', 'storyLocationId', 'name', 'visualPrompt'], (location) => {
    safeId(location.id, `continuityGraph.locations[${index}].id`)
    safeId(location.storyLocationId, `continuityGraph.locations[${index}].storyLocationId`, true)
    text(location.name, `continuityGraph.locations[${index}].name`, 120)
    text(location.visualPrompt, `continuityGraph.locations[${index}].visualPrompt`, 1_000)
  }))

  graph.frames.forEach((inputFrame, index) => assertAssetSlot(inputFrame, `continuityGraph.frames[${index}]`, ['id', 'shotId', 'role', 'required'], (frame) => {
    safeId(frame.id, `continuityGraph.frames[${index}].id`)
    if (!shotIds.has(frame.shotId)) fail('DANGLING_SHOT', `continuityGraph.frames[${index}].shotId is unknown`)
    if (!FRAME_ROLES.has(frame.role)) fail('INVALID_FRAME_ROLE', `continuityGraph.frames[${index}].role is unsupported`)
    if (typeof frame.required !== 'boolean') fail('INVALID_BOOLEAN', `continuityGraph.frames[${index}].required must be boolean`)
  }))

  if (!legacy) graph.candidates.forEach((inputCandidate, index) => {
    const path = `continuityGraph.candidates[${index}]`
    const candidate = record(inputCandidate, path)
    exactKeys(candidate, ['id', 'shotId', 'attempt', 'label', 'source', 'generationMode', 'asset', 'inputFingerprint', 'createdAt'], path)
    safeId(candidate.id, `${path}.id`)
    if (!shotIds.has(candidate.shotId)) fail('DANGLING_SHOT', `${path}.shotId is unknown`)
    integer(candidate.attempt, `${path}.attempt`, 1, VIDEO_CONTINUITY_LIMITS.maxCandidatesPerShot)
    text(candidate.label, `${path}.label`, 160)
    if (!CANDIDATE_SOURCES.has(candidate.source)) fail('INVALID_CANDIDATE_SOURCE', `${path}.source is unsupported`)
    if (!GENERATION_MODES.has(candidate.generationMode)) fail('INVALID_GENERATION_MODE', `${path}.generationMode is unsupported`)
    normalizeVideoAssetBinding(candidate.asset, `${path}.asset`)
    safeId(candidate.inputFingerprint, `${path}.inputFingerprint`)
    integer(candidate.createdAt, `${path}.createdAt`, 1, Number.MAX_SAFE_INTEGER)
  })

  graph.shots.forEach((inputShot, index) => {
    const path = `continuityGraph.shots[${index}]`
    const shot = record(inputShot, path)
    exactKeys(shot, legacy
      ? ['id', 'storyShotId', 'sceneId', 'label', 'locationId', 'characterBindings', 'frameIds', 'status', 'latestReviewId', 'inputFingerprint']
      : ['id', 'storyShotId', 'sceneId', 'label', 'locationId', 'characterBindings', 'frameIds', 'candidateIds', 'selectedCandidateId', 'status', 'latestReviewId', 'inputFingerprint'], path)
    safeId(shot.id, `${path}.id`)
    safeId(shot.storyShotId, `${path}.storyShotId`, true)
    safeId(shot.sceneId, `${path}.sceneId`, true)
    text(shot.label, `${path}.label`, 240)
    if (shot.locationId !== null && !locationIds.has(shot.locationId)) fail('DANGLING_LOCATION', `${path}.locationId is unknown`)
    if (!Array.isArray(shot.characterBindings) || shot.characterBindings.length > VIDEO_CONTINUITY_LIMITS.maxBindingsPerShot) fail('INVALID_CHARACTER_BINDINGS', `${path}.characterBindings is invalid`)
    const seenCharacters = new Set()
    shot.characterBindings.forEach((inputBinding, bindingIndex) => {
      const bindingPath = `${path}.characterBindings[${bindingIndex}]`
      const binding = record(inputBinding, bindingPath)
      exactKeys(binding, ['characterId', 'wardrobeId'], bindingPath)
      if (!characterIds.has(binding.characterId)) fail('DANGLING_CHARACTER', `${bindingPath}.characterId is unknown`)
      if (!wardrobeIds.has(binding.wardrobeId)) fail('DANGLING_WARDROBE', `${bindingPath}.wardrobeId is unknown`)
      if (seenCharacters.has(binding.characterId)) fail('DUPLICATE_CHARACTER_BINDING', `${path} binds a character more than once`)
      seenCharacters.add(binding.characterId)
      const wardrobe = graph.wardrobes.find(({ id }) => id === binding.wardrobeId)
      if (wardrobe.characterId !== binding.characterId) fail('WARDROBE_CHARACTER_MISMATCH', `${bindingPath}.wardrobeId belongs to another character`)
    })
    if (!Array.isArray(shot.frameIds) || shot.frameIds.length < 1 || shot.frameIds.length > 2 || new Set(shot.frameIds).size !== shot.frameIds.length) fail('INVALID_FRAME_REFERENCES', `${path}.frameIds is invalid`)
    shot.frameIds.forEach((frameId) => {
      if (!frameIds.has(frameId)) fail('DANGLING_FRAME', `${path}.frameIds contains ${frameId}`)
      if (graph.frames.find(({ id }) => id === frameId)?.shotId !== shot.id) fail('CROSS_SHOT_FRAME', `${path}.frameIds contains a frame owned by another shot`)
    })
    if (!legacy) {
      if (!Array.isArray(shot.candidateIds) || shot.candidateIds.length > VIDEO_CONTINUITY_LIMITS.maxCandidatesPerShot || new Set(shot.candidateIds).size !== shot.candidateIds.length) {
        fail('INVALID_CANDIDATE_REFERENCES', `${path}.candidateIds is invalid`)
      }
      shot.candidateIds.forEach((candidateId) => {
        const candidate = candidatesById.get(candidateId)
        if (!candidate) fail('DANGLING_CANDIDATE', `${path}.candidateIds contains ${candidateId}`)
        if (candidate.shotId !== shot.id) fail('CROSS_SHOT_CANDIDATE', `${path}.candidateIds contains a candidate owned by another shot`)
      })
      safeId(shot.selectedCandidateId, `${path}.selectedCandidateId`, true)
      if (shot.selectedCandidateId !== null && !shot.candidateIds.includes(shot.selectedCandidateId)) fail('DANGLING_CANDIDATE', `${path}.selectedCandidateId is not in candidateIds`)
      const selected = shot.selectedCandidateId === null ? null : candidatesById.get(shot.selectedCandidateId)
      if (selected && selected.inputFingerprint !== shot.inputFingerprint) fail('STALE_SELECTED_CANDIDATE', `${path}.selectedCandidateId was generated from stale inputs`)
    }
    if (!(legacy ? LEGACY_SHOT_STATUSES : SHOT_STATUSES).has(shot.status)) fail('INVALID_SHOT_STATUS', `${path}.status is unsupported`)
    if (shot.latestReviewId !== null && !reviewIds.has(shot.latestReviewId)) fail('DANGLING_REVIEW', `${path}.latestReviewId is unknown`)
    safeId(shot.inputFingerprint, `${path}.inputFingerprint`)
  })

  if (!legacy) {
    for (const shot of graph.shots) {
      const actual = graph.candidates.filter(({ shotId }) => shotId === shot.id).map(({ id }) => id)
      if (actual.length !== shot.candidateIds.length || actual.some((candidateId, index) => shot.candidateIds[index] !== candidateId)) {
        fail('CANDIDATE_ORDER_MISMATCH', `shot ${shot.id} candidateIds must match graph candidate order`)
      }
      const attempts = graph.candidates.filter(({ shotId }) => shotId === shot.id).map(({ attempt }) => attempt)
      if (attempts.some((attempt, index) => attempt !== index + 1)) fail('CANDIDATE_ATTEMPT_MISMATCH', `shot ${shot.id} candidate attempts must be contiguous`)
    }
  }

  graph.reviews.forEach((review, index) => assertReview(review, `continuityGraph.reviews[${index}]`, shotIds, candidatesById, legacy))
  for (const shot of graph.shots) {
    if (dependencyFingerprint(graph, shot) !== shot.inputFingerprint) fail('SHOT_FINGERPRINT_MISMATCH', `shot ${shot.id} input fingerprint is inconsistent`)
    const active = graph.reviews.filter((review) => review.shotId === shot.id && review.status === 'active')
    if (active.length > 1) fail('MULTIPLE_ACTIVE_REVIEWS', `shot ${shot.id} has multiple active reviews`)
    if ((active[0]?.id ?? null) !== shot.latestReviewId) fail('LATEST_REVIEW_MISMATCH', `shot ${shot.id} latestReviewId is inconsistent`)
    if (active[0] && active[0].inputFingerprint !== shot.inputFingerprint) fail('STALE_ACTIVE_REVIEW', `shot ${shot.id} active review uses stale inputs`)
    if (!legacy && active[0] && active[0].candidateId !== shot.selectedCandidateId) fail('REVIEW_CANDIDATE_MISMATCH', `shot ${shot.id} active review does not target its selected candidate`)
    const assetsReady = requiredSlotsReady(graph, shot)
    const expected = !assetsReady
      ? 'blocked'
      : !legacy && shot.selectedCandidateId === null
        ? 'candidate-required'
        : active[0]?.decision === 'accept'
          ? 'approved'
          : active[0]?.decision === 'retry'
            ? 'retry-required'
            : 'ready'
    if (shot.status !== expected) fail('SHOT_REVIEW_STATUS_MISMATCH', `shot ${shot.id} status does not match its assets and active review`)
  }
  integer(graph.revision, 'continuityGraph.revision', 0, Number.MAX_SAFE_INTEGER)
  integer(graph.createdAt, 'continuityGraph.createdAt', 1, Number.MAX_SAFE_INTEGER)
  integer(graph.updatedAt, 'continuityGraph.updatedAt', graph.createdAt, Number.MAX_SAFE_INTEGER)
  return graph
}

export function assertVideoContinuityGraph(input) {
  return assertVideoContinuityGraphSchema(input, false)
}

export function migrateVideoContinuityGraph(input, options = {}) {
  const validated = clone(assertVideoContinuityGraphSchema(input, true))
  if (validated.schemaVersion === VIDEO_CONTINUITY_GRAPH_SCHEMA_VERSION) return assertVideoContinuityGraph(validated)
  const now = integer(options.now ?? validated.updatedAt, 'options.now', validated.updatedAt, Number.MAX_SAFE_INTEGER)
  validated.schemaVersion = VIDEO_CONTINUITY_GRAPH_SCHEMA_VERSION
  validated.candidates = []
  validated.reviews = validated.reviews.map((review) => ({ ...review, candidateId: null, status: 'superseded' }))
  validated.shots = validated.shots.map((shot) => ({
    ...shot,
    candidateIds: [],
    selectedCandidateId: null,
    latestReviewId: null,
    status: requiredSlotsReady(validated, shot) ? 'candidate-required' : 'blocked',
  }))
  validated.revision += 1
  validated.updatedAt = now
  return assertVideoContinuityGraph(validated)
}

function validPersistedAsset(asset) {
  if (!asset) return null
  try { return clone(normalizeAssetBinding(asset)) } catch { return null }
}

function assetSlotState(previous, fallbackStatus = 'planned') {
  const asset = validPersistedAsset(previous?.asset)
  return asset ? { status: previous?.status === 'approved' ? 'approved' : 'ready', asset } : { status: fallbackStatus, asset: null }
}

function dependencyFingerprint(graph, shot) {
  const slots = [`shot:${shot.id}:${token(shot.label)}`]
  if (shot.locationId) {
    const location = graph.locations.find(({ id }) => id === shot.locationId)
    slots.push(`location:${location?.id ?? 'missing'}:${token(location?.visualPrompt ?? 'missing')}:${location?.asset?.contentHash ?? 'missing'}:${location?.status ?? 'missing'}`)
  }
  for (const binding of shot.characterBindings) {
    const character = graph.characters.find(({ id }) => id === binding.characterId)
    slots.push(`identity:${character?.id ?? 'missing'}:${token(character?.identityLock ?? 'missing')}`)
    for (const viewId of character?.viewIds ?? []) {
      const view = graph.views.find(({ id }) => id === viewId)
      if (view?.required) slots.push(`view:${view.id}:${view.asset?.contentHash ?? 'missing'}:${view.status}`)
    }
    const wardrobe = graph.wardrobes.find(({ id }) => id === binding.wardrobeId)
    slots.push(`wardrobe:${wardrobe?.id ?? 'missing'}:${token(`${wardrobe?.label ?? ''}|${wardrobe?.trigger ?? ''}`)}:${wardrobe?.asset?.contentHash ?? 'missing'}:${wardrobe?.status ?? 'missing'}`)
  }
  for (const frameId of shot.frameIds) {
    const frame = graph.frames.find(({ id }) => id === frameId)
    if (frame?.required) slots.push(`frame:${frame.id}:${frame.asset?.contentHash ?? 'missing'}:${frame.status}`)
  }
  return `inputs-${token(slots.sort().join('|'))}`
}

function requiredSlotsReady(graph, shot) {
  const slots = []
  if (shot.locationId) slots.push(graph.locations.find(({ id }) => id === shot.locationId))
  for (const binding of shot.characterBindings) {
    const character = graph.characters.find(({ id }) => id === binding.characterId)
    slots.push(...(character?.viewIds ?? []).map((viewId) => graph.views.find(({ id }) => id === viewId)).filter((view) => view?.required))
    slots.push(graph.wardrobes.find(({ id }) => id === binding.wardrobeId))
  }
  slots.push(...shot.frameIds.map((frameId) => graph.frames.find(({ id }) => id === frameId)).filter((frame) => frame?.required))
  return slots.every((slot) => slot?.status === 'approved')
}

function refreshShotState(graph, shot, previousFingerprint = shot.inputFingerprint) {
  const nextFingerprint = dependencyFingerprint(graph, shot)
  if (nextFingerprint !== previousFingerprint) {
    for (const review of graph.reviews) {
      if (review.shotId === shot.id && review.status === 'active') review.status = 'superseded'
    }
    shot.latestReviewId = null
    shot.selectedCandidateId = null
  }
  shot.inputFingerprint = nextFingerprint
  const active = graph.reviews.find((review) => review.id === shot.latestReviewId && review.status === 'active')
  shot.status = !requiredSlotsReady(graph, shot)
    ? 'blocked'
    : shot.selectedCandidateId === null
      ? 'candidate-required'
      : active?.decision === 'accept'
        ? 'approved'
        : active?.decision === 'retry'
          ? 'retry-required'
          : 'ready'
}

function refreshAllShots(graph, previousFingerprints = new Map()) {
  graph.shots.forEach((shot) => refreshShotState(graph, shot, previousFingerprints.get(shot.id) ?? shot.inputFingerprint))
}

function profileByStoryCharacter(profiles, storyCharacter) {
  return (storyCharacter.id
    ? profiles.find((profile) => profile.storyCharacterId === storyCharacter.id)
    : null)
    ?? profiles.find((profile) => profile.name.trim().toLocaleLowerCase('zh-CN') === storyCharacter.name.trim().toLocaleLowerCase('zh-CN'))
}

export function createVideoContinuityGraph({ story = null, characterProfiles, generationMode = 'quality', characterMode = 'professional', now = Date.now(), previous = null } = {}) {
  if (!Array.isArray(characterProfiles) || !characterProfiles.length) fail('INVALID_CHARACTER_PROFILES', 'characterProfiles must be a non-empty array')
  integer(now, 'now', 1, Number.MAX_SAFE_INTEGER)
  const prior = previous ? clone(migrateVideoContinuityGraph(previous, { now })) : null
  const priorByStoryCharacter = new Map((prior?.characters ?? []).map((character) => [character.storyCharacterId, character]))
  const priorByProfileId = new Map((prior?.characters ?? []).map((character) => [character.profileId, character]))
  const priorByName = new Map((prior?.characters ?? []).map((character) => [character.name.trim().toLocaleLowerCase('zh-CN'), character]))
  const priorViews = new Map((prior?.views ?? []).map((view) => [`${view.characterId}:${view.view}`, view]))
  const priorWardrobes = new Map((prior?.wardrobes ?? []).map((wardrobe) => [`${wardrobe.characterId}:${wardrobe.profileWardrobeId}`, wardrobe]))
  const priorLocations = new Map((prior?.locations ?? []).map((location) => [location.storyLocationId ?? location.name, location]))
  const priorFrames = new Map((prior?.frames ?? []).map((frame) => [`${frame.shotId}:${frame.role}`, frame]))
  const priorShots = new Map((prior?.shots ?? []).map((shot) => [shot.storyShotId ?? shot.id, shot]))

  const storyCharacters = Array.isArray(story?.characters) && story.characters.length
    ? story.characters
    : characterProfiles.map((profile) => ({ id: profile.storyCharacterId, name: profile.name, description: profile.identityLock, visualPrompt: profile.identityLock }))
  const characters = []
  const views = []
  const wardrobes = []
  for (const storyCharacter of storyCharacters.slice(0, VIDEO_CONTINUITY_LIMITS.maxCharacters)) {
    const profile = profileByStoryCharacter(characterProfiles, storyCharacter) ?? characterProfiles[characters.length] ?? characterProfiles[0]
    const priorCharacter = (storyCharacter.id ? priorByStoryCharacter.get(storyCharacter.id) : null)
      ?? priorByProfileId.get(profile.id)
      ?? priorByName.get(storyCharacter.name.trim().toLocaleLowerCase('zh-CN'))
    const characterId = priorCharacter?.id ?? stableId('continuity-character', storyCharacter.id ?? profile.id, storyCharacter.name)
    const viewIds = []
    for (const profileView of profile.views) {
      const priorView = priorViews.get(`${priorCharacter?.id ?? characterId}:${profileView.view}`)
      const slot = assetSlotState(priorView)
      const view = {
        id: priorView?.id ?? stableId('continuity-view', characterId, profileView.view),
        characterId,
        profileViewId: profileView.id,
        view: profileView.view,
        required: characterMode === 'professional' ? ['front', 'side', 'back'].includes(profileView.view) : profileView.view === 'front',
        ...slot,
      }
      views.push(view)
      viewIds.push(view.id)
    }
    const wardrobeIds = []
    for (const profileWardrobe of profile.wardrobeStates) {
      const priorWardrobe = priorWardrobes.get(`${priorCharacter?.id ?? characterId}:${profileWardrobe.id}`)
      const wardrobe = {
        id: priorWardrobe?.id ?? stableId('continuity-wardrobe', characterId, profileWardrobe.id),
        characterId,
        profileWardrobeId: profileWardrobe.id,
        label: profileWardrobe.label,
        trigger: profileWardrobe.trigger,
        ...assetSlotState(priorWardrobe),
      }
      wardrobes.push(wardrobe)
      wardrobeIds.push(wardrobe.id)
    }
    characters.push({
      id: characterId,
      storyCharacterId: storyCharacter.id ?? null,
      profileId: profile.id,
      name: storyCharacter.name ?? profile.name,
      identityLock: profile.identityLock,
      viewIds,
      wardrobeIds,
    })
  }

  const locations = (story?.locations ?? []).slice(0, VIDEO_CONTINUITY_LIMITS.maxLocations).map((storyLocation) => {
    const priorLocation = priorLocations.get(storyLocation.id) ?? priorLocations.get(storyLocation.name)
    return {
      id: priorLocation?.id ?? stableId('continuity-location', storyLocation.id, storyLocation.name),
      storyLocationId: storyLocation.id,
      name: storyLocation.name,
      visualPrompt: storyLocation.visualPrompt || storyLocation.description || storyLocation.name,
      ...assetSlotState(priorLocation),
    }
  })
  if (!locations.length && !story) {
    const priorLocation = prior?.locations[0]
    locations.push({
      id: priorLocation?.id ?? 'continuity-location-unassigned',
      storyLocationId: null,
      name: '待定义地点',
      visualPrompt: '等待场景美术节点建立地点、光线、时代与构图基准。',
      ...assetSlotState(priorLocation),
    })
  }

  const graph = {
    kind: GRAPH_KIND,
    schemaVersion: VIDEO_CONTINUITY_GRAPH_SCHEMA_VERSION,
    storyProjectId: story?.id ?? null,
    storyRevision: story?.revision ?? null,
    characters,
    views,
    wardrobes,
    locations,
    frames: [],
    shots: [],
    candidates: clone(prior?.candidates ?? []),
    reviews: clone(prior?.reviews ?? []),
    revision: prior ? prior.revision + 1 : 0,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  }

  const graphCharacterByStoryId = new Map(characters.map((character) => [character.storyCharacterId, character]))
  const graphLocationByStoryId = new Map(locations.map((location) => [location.storyLocationId, location]))
  for (const scene of story?.scenes ?? []) {
    for (const storyShot of scene.shots) {
      const priorShot = priorShots.get(storyShot.id)
      const shotId = priorShot?.id ?? stableId('continuity-shot', storyShot.id)
      const frameIds = []
      for (const role of ['first-frame', 'last-frame']) {
        if (role === 'last-frame' && story.settings.frameStrategy !== 'start-end') continue
        const priorFrame = priorFrames.get(`${priorShot?.id ?? shotId}:${role}`)
        const frame = {
          id: priorFrame?.id ?? stableId('continuity-frame', shotId, role),
          shotId,
          role,
          required: generationMode === 'quality',
          ...assetSlotState(priorFrame),
        }
        graph.frames.push(frame)
        frameIds.push(frame.id)
      }
      const characterBindings = storyShot.characterIds.flatMap((storyCharacterId) => {
        const character = graphCharacterByStoryId.get(storyCharacterId)
        if (!character) return []
        const priorBinding = priorShot?.characterBindings.find((binding) => binding.characterId === character.id)
        const wardrobeId = priorBinding && character.wardrobeIds.includes(priorBinding.wardrobeId)
          ? priorBinding.wardrobeId
          : character.wardrobeIds[0]
        return [{ characterId: character.id, wardrobeId }]
      })
      graph.shots.push({
        id: shotId,
        storyShotId: storyShot.id,
        sceneId: scene.id,
        label: `${scene.heading} · ${storyShot.title}`.slice(0, 240),
        locationId: graphLocationByStoryId.get(scene.locationId)?.id ?? null,
        characterBindings,
        frameIds,
        candidateIds: clone(priorShot?.candidateIds ?? []),
        selectedCandidateId: priorShot?.selectedCandidateId ?? null,
        status: 'blocked',
        latestReviewId: priorShot?.latestReviewId ?? null,
        inputFingerprint: priorShot?.inputFingerprint ?? 'inputs-initial',
      })
    }
  }
  const validShotIds = new Set(graph.shots.map(({ id }) => id))
  graph.candidates = graph.candidates.filter((candidate) => validShotIds.has(candidate.shotId))
  graph.reviews = graph.reviews.filter((review) => validShotIds.has(review.shotId))
  const validCandidateIds = new Set(graph.candidates.map(({ id }) => id))
  graph.shots.forEach((shot) => {
    shot.candidateIds = graph.candidates.filter(({ shotId }) => shotId === shot.id).map(({ id }) => id)
    if (!validCandidateIds.has(shot.selectedCandidateId)) shot.selectedCandidateId = null
  })
  graph.reviews.forEach((review) => {
    if (review.candidateId !== null && !validCandidateIds.has(review.candidateId)) review.status = 'superseded'
  })
  const previousFingerprints = new Map((prior?.shots ?? []).map((shot) => [shot.id, shot.inputFingerprint]))
  refreshAllShots(graph, previousFingerprints)
  return assertVideoContinuityGraph(graph)
}

function findAssetSlot(graph, targetId) {
  for (const collection of ['views', 'wardrobes', 'locations', 'frames']) {
    const slot = graph[collection].find(({ id }) => id === targetId)
    if (slot) return { collection, slot }
  }
  fail('UNKNOWN_ASSET_TARGET', `Unknown continuity asset target ${targetId}`)
}

function touch(graph, now, previousFingerprints) {
  refreshAllShots(graph, previousFingerprints)
  graph.revision += 1
  graph.updatedAt = now
  return assertVideoContinuityGraph(graph)
}

export function bindContinuityAsset(graphInput, targetId, bindingInput, options = {}) {
  const graph = clone(assertVideoContinuityGraph(graphInput))
  safeId(targetId, 'targetId')
  const binding = clone(normalizeAssetBinding(bindingInput))
  const now = integer(options.now ?? Date.now(), 'options.now', graph.updatedAt, Number.MAX_SAFE_INTEGER)
  const previousFingerprints = new Map(graph.shots.map((shot) => [shot.id, shot.inputFingerprint]))
  const { slot } = findAssetSlot(graph, targetId)
  slot.asset = binding
  slot.status = 'ready'
  return touch(graph, now, previousFingerprints)
}

export function approveContinuityAsset(graphInput, targetId, options = {}) {
  const graph = clone(assertVideoContinuityGraph(graphInput))
  safeId(targetId, 'targetId')
  const now = integer(options.now ?? Date.now(), 'options.now', graph.updatedAt, Number.MAX_SAFE_INTEGER)
  const previousFingerprints = new Map(graph.shots.map((shot) => [shot.id, shot.inputFingerprint]))
  const { slot } = findAssetSlot(graph, targetId)
  if (!slot.asset || slot.status === 'planned') fail('ASSET_NOT_BOUND', `${targetId} has no bound asset`)
  slot.status = 'approved'
  return touch(graph, now, previousFingerprints)
}

export function unbindContinuityAsset(graphInput, targetId, options = {}) {
  const graph = clone(assertVideoContinuityGraph(graphInput))
  safeId(targetId, 'targetId')
  const now = integer(options.now ?? Date.now(), 'options.now', graph.updatedAt, Number.MAX_SAFE_INTEGER)
  const previousFingerprints = new Map(graph.shots.map((shot) => [shot.id, shot.inputFingerprint]))
  const { slot } = findAssetSlot(graph, targetId)
  slot.asset = null
  slot.status = 'planned'
  return touch(graph, now, previousFingerprints)
}

export function assignContinuityWardrobe(graphInput, shotId, characterId, wardrobeId, options = {}) {
  const graph = clone(assertVideoContinuityGraph(graphInput))
  ;[shotId, characterId, wardrobeId].forEach((value, index) => safeId(value, ['shotId', 'characterId', 'wardrobeId'][index]))
  const now = integer(options.now ?? Date.now(), 'options.now', graph.updatedAt, Number.MAX_SAFE_INTEGER)
  const shot = graph.shots.find(({ id }) => id === shotId)
  if (!shot) fail('UNKNOWN_SHOT', `Unknown continuity shot ${shotId}`)
  const binding = shot.characterBindings.find((item) => item.characterId === characterId)
  if (!binding) fail('SHOT_CHARACTER_NOT_BOUND', `Shot ${shotId} does not use character ${characterId}`)
  const wardrobe = graph.wardrobes.find(({ id }) => id === wardrobeId)
  if (!wardrobe) fail('UNKNOWN_WARDROBE', `Unknown continuity wardrobe ${wardrobeId}`)
  if (wardrobe.characterId !== characterId) fail('WARDROBE_CHARACTER_MISMATCH', `${wardrobeId} belongs to another character`)
  const previousFingerprints = new Map(graph.shots.map((item) => [item.id, item.inputFingerprint]))
  binding.wardrobeId = wardrobeId
  return touch(graph, now, previousFingerprints)
}

export function registerContinuityCandidate(graphInput, candidateInput, options = {}) {
  const graph = clone(assertVideoContinuityGraph(graphInput))
  const value = record(candidateInput, 'candidate')
  exactKeys(value, ['shotId', 'label', 'source', 'generationMode', 'inputFingerprint', 'binding'], 'candidate')
  safeId(value.shotId, 'candidate.shotId')
  text(value.label, 'candidate.label', 160)
  if (!CANDIDATE_SOURCES.has(value.source)) fail('INVALID_CANDIDATE_SOURCE', 'candidate.source is unsupported')
  if (!GENERATION_MODES.has(value.generationMode)) fail('INVALID_GENERATION_MODE', 'candidate.generationMode is unsupported')
  safeId(value.inputFingerprint, 'candidate.inputFingerprint')
  const binding = clone(normalizeVideoAssetBinding(value.binding, 'candidate.binding'))
  const shot = graph.shots.find(({ id }) => id === value.shotId)
  if (!shot) fail('UNKNOWN_SHOT', `Unknown continuity shot ${value.shotId}`)
  if (!requiredSlotsReady(graph, shot)) fail('CANDIDATE_INPUTS_BLOCKED', `Shot ${value.shotId} cannot register video candidates before required assets are approved`)
  if (value.inputFingerprint !== shot.inputFingerprint) fail('STALE_CANDIDATE_INPUTS', `Shot ${value.shotId} inputs changed while this candidate was rendering`)
  const shotCandidates = graph.candidates.filter(({ shotId }) => shotId === shot.id)
  if (shotCandidates.length >= VIDEO_CONTINUITY_LIMITS.maxCandidatesPerShot) fail('CANDIDATE_LIMIT', `Shot ${value.shotId} reached its candidate limit`)
  if (graph.candidates.length >= VIDEO_CONTINUITY_LIMITS.maxCandidates) fail('CANDIDATE_LIMIT', 'Continuity candidate limit reached')
  if (shotCandidates.some((candidate) => (
    candidate.inputFingerprint === shot.inputFingerprint
    && candidate.asset.libraryItemId === binding.libraryItemId
    && candidate.asset.libraryVersionId === binding.libraryVersionId
    && candidate.asset.contentHash === binding.contentHash
  ))) fail('DUPLICATE_CANDIDATE', `Shot ${value.shotId} already contains this immutable video version`)
  const now = integer(options.now ?? Date.now(), 'options.now', graph.updatedAt, Number.MAX_SAFE_INTEGER)
  const attempt = shotCandidates.length + 1
  const candidate = {
    id: stableId('continuity-candidate', graph.storyProjectId ?? 'unbound', shot.id, attempt, binding.libraryVersionId, binding.contentHash),
    shotId: shot.id,
    attempt,
    label: value.label.trim(),
    source: value.source,
    generationMode: value.generationMode,
    asset: binding,
    inputFingerprint: shot.inputFingerprint,
    createdAt: now,
  }
  if (graph.candidates.some(({ id }) => id === candidate.id)) fail('DUPLICATE_ID', `Continuity candidate already exists: ${candidate.id}`)
  const previousFingerprints = new Map(graph.shots.map((item) => [item.id, item.inputFingerprint]))
  graph.candidates.push(candidate)
  shot.candidateIds.push(candidate.id)
  return touch(graph, now, previousFingerprints)
}

export function selectContinuityCandidate(graphInput, shotId, candidateId, options = {}) {
  const graph = clone(assertVideoContinuityGraph(graphInput))
  safeId(shotId, 'shotId')
  safeId(candidateId, 'candidateId')
  const shot = graph.shots.find(({ id }) => id === shotId)
  if (!shot) fail('UNKNOWN_SHOT', `Unknown continuity shot ${shotId}`)
  const candidate = graph.candidates.find(({ id }) => id === candidateId)
  if (!candidate) fail('UNKNOWN_CANDIDATE', `Unknown continuity candidate ${candidateId}`)
  if (candidate.shotId !== shot.id || !shot.candidateIds.includes(candidate.id)) fail('CROSS_SHOT_CANDIDATE', `${candidateId} does not belong to ${shotId}`)
  if (!requiredSlotsReady(graph, shot)) fail('CANDIDATE_INPUTS_BLOCKED', `Shot ${shotId} required assets are not approved`)
  if (candidate.inputFingerprint !== shot.inputFingerprint) fail('STALE_CANDIDATE', `${candidateId} was generated from stale shot inputs`)
  if (shot.selectedCandidateId === candidate.id) fail('CANDIDATE_ALREADY_SELECTED', `${candidateId} is already selected`)
  const now = integer(options.now ?? Date.now(), 'options.now', graph.updatedAt, Number.MAX_SAFE_INTEGER)
  const previousFingerprints = new Map(graph.shots.map((item) => [item.id, item.inputFingerprint]))
  graph.reviews.forEach((review) => { if (review.shotId === shot.id && review.status === 'active') review.status = 'superseded' })
  shot.latestReviewId = null
  shot.selectedCandidateId = candidate.id
  return touch(graph, now, previousFingerprints)
}

function reviewRecommendations(scores) {
  const available = SCORE_KEYS
    .filter((key) => scores[key] !== null)
    .map((key) => ({ key, score: scores[key] }))
    .sort((a, b) => a.score - b.score || SCORE_KEYS.indexOf(a.key) - SCORE_KEYS.indexOf(b.key))
  const minimum = available[0]?.score
  const weakest = available.filter(({ score }) => score === minimum).slice(0, 2).map(({ key }) => key)
  const actions = {
    identity: '锁定已批准角色视图并降低镜头形变；只重生当前镜头。',
    wardrobe: '核对镜头服饰状态与批准版本，重新绑定后再生成当前镜头。',
    location: '固定已批准地点参考、光线与空间方向，再生成当前镜头。',
    sharpness: '保留构图，改用质量母版或时序精修重跑当前镜头。',
    motion: '收敛动作与运镜幅度，重写运动约束后只重跑当前镜头。',
  }
  return {
    reasons: weakest.map((key) => `${key} 是本次人工评分中的相对弱项（${scores[key]}/5）。`),
    recommendedActions: weakest.map((key) => actions[key]),
  }
}

export function recordContinuityReview(graphInput, reviewInput, options = {}) {
  const graph = clone(assertVideoContinuityGraph(graphInput))
  const value = record(reviewInput, 'review')
  exactKeys(value, ['shotId', 'reviewerId', 'scores', 'decision', 'notes'], 'review')
  safeId(value.shotId, 'review.shotId')
  safeId(value.reviewerId, 'review.reviewerId')
  if (!DECISIONS.has(value.decision)) fail('INVALID_REVIEW_DECISION', 'review.decision is unsupported')
  if (typeof value.notes !== 'string' || value.notes.length > VIDEO_CONTINUITY_LIMITS.maxNotes) fail('INVALID_REVIEW_NOTES', 'review.notes is invalid')
  const scores = record(value.scores, 'review.scores')
  exactKeys(scores, SCORE_KEYS, 'review.scores')
  SCORE_KEYS.forEach((key) => assertScore(scores[key], `review.scores.${key}`))
  if (SCORE_KEYS.filter((key) => scores[key] !== null).length < 3) fail('INSUFFICIENT_REVIEW_SCORES', 'review.scores requires at least three applicable dimensions')
  const shot = graph.shots.find(({ id }) => id === value.shotId)
  if (!shot) fail('UNKNOWN_SHOT', `Unknown continuity shot ${value.shotId}`)
  if (!['ready', 'approved', 'retry-required'].includes(shot.status)) fail('SHOT_CANDIDATE_REQUIRED', `Shot ${value.shotId} requires approved inputs and an explicitly selected current video candidate`)
  const candidate = graph.candidates.find(({ id }) => id === shot.selectedCandidateId)
  if (!candidate || candidate.inputFingerprint !== shot.inputFingerprint) fail('SHOT_CANDIDATE_REQUIRED', `Shot ${value.shotId} has no current video candidate`)
  const now = integer(options.now ?? Date.now(), 'options.now', graph.updatedAt, Number.MAX_SAFE_INTEGER)
  graph.reviews.forEach((review) => { if (review.shotId === shot.id && review.status === 'active') review.status = 'superseded' })
  const attempt = graph.reviews.filter((review) => review.shotId === shot.id).length + 1
  const recommendation = value.decision === 'retry' ? reviewRecommendations(scores) : { reasons: [], recommendedActions: [] }
  const review = {
    id: stableId('continuity-review', graph.storyProjectId ?? 'unbound', shot.id, attempt, now),
    shotId: shot.id,
    candidateId: candidate.id,
    attempt,
    reviewerId: value.reviewerId,
    scores: clone(scores),
    decision: value.decision,
    notes: value.notes,
    ...recommendation,
    inputFingerprint: shot.inputFingerprint,
    status: 'active',
    createdAt: now,
  }
  graph.reviews.push(review)
  if (graph.reviews.length > VIDEO_CONTINUITY_LIMITS.maxReviews) fail('REVIEW_LIMIT', 'Continuity review limit reached')
  shot.latestReviewId = review.id
  shot.status = value.decision === 'accept' ? 'approved' : 'retry-required'
  graph.revision += 1
  graph.updatedAt = now
  return assertVideoContinuityGraph(graph)
}

export function continuityGraphSummary(graphInput) {
  const graph = assertVideoContinuityGraph(graphInput)
  const assetSlots = [...graph.views, ...graph.wardrobes, ...graph.locations, ...graph.frames]
  const requiredSlots = assetSlots.filter((slot) => slot.required !== false || !('required' in slot))
  const currentCandidateIds = new Set(graph.candidates
    .filter((candidate) => graph.shots.some((shot) => shot.id === candidate.shotId && shot.inputFingerprint === candidate.inputFingerprint))
    .map(({ id }) => id))
  return {
    characters: graph.characters.length,
    locations: graph.locations.length,
    shots: graph.shots.length,
    requiredAssets: requiredSlots.length,
    approvedAssets: requiredSlots.filter(({ status }) => status === 'approved').length,
    blockedShots: graph.shots.filter(({ status }) => status === 'blocked').length,
    candidateRequiredShots: graph.shots.filter(({ status }) => status === 'candidate-required').length,
    readyShots: graph.shots.filter(({ status }) => status === 'ready').length,
    approvedShots: graph.shots.filter(({ status }) => status === 'approved').length,
    retryShots: graph.shots.filter(({ status }) => status === 'retry-required').length,
    candidates: graph.candidates.length,
    currentCandidates: currentCandidateIds.size,
    staleCandidates: graph.candidates.length - currentCandidateIds.size,
    selectedCandidates: graph.shots.filter(({ selectedCandidateId }) => selectedCandidateId !== null).length,
    calibrated: false,
  }
}

export function continuityAssetProducerReady(graphInput) {
  const summary = continuityGraphSummary(graphInput)
  return summary.requiredAssets > 0 && summary.approvedAssets === summary.requiredAssets
}

export function continuityVideoReviewReady(graphInput) {
  const summary = continuityGraphSummary(graphInput)
  return summary.shots > 0 && summary.approvedShots === summary.shots
}
