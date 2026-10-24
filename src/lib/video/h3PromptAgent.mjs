import { VIDEO_DURATION_FRAMES } from './videoPresetPolicy.mjs'

export const H3_PROMPT_AGENT_SCHEMA_VERSION = 1
export const H3_PROMPT_AGENT_VERSION = 'aeonquill-h3-shot-planner-v2'

export const H3_SCENARIO_PRESETS = Object.freeze({
  auto: Object.freeze({
    id: 'auto',
    label: '智能匹配',
    description: '根据主体、对白、画幅与动作强度选择受控场景结构。',
    recommendedPreset: 'master720',
  }),
  cinematic: Object.freeze({
    id: 'cinematic',
    label: '电影叙事',
    description: '强调镜头语言、光线层次、空间连续性与自然声画同步。',
    style: 'Live-action, cinematic, coherent lighting, physically believable motion',
    continuity: 'Maintain subject identity, wardrobe, scene geometry, lighting direction, and screen direction throughout the shot.',
    soundscape: 'Natural synchronized ambience and physical action sounds matching every visible movement.',
    music: 'Sparse cinematic instrumentation at a restrained tempo, with dynamics following the visible action.',
    recommendedPreset: 'master720',
  }),
  shortDrama: Object.freeze({
    id: 'shortDrama',
    label: '竖屏短剧',
    description: '优先人物身份、对白可懂度、面部稳定与有限镜头调度。',
    style: 'Live-action short drama, clear facial detail, readable blocking, controlled depth of field',
    continuity: 'Keep every speaker visually consistent, preserve eyelines and lip synchronization, and avoid unmotivated cuts or background changes.',
    soundscape: 'Clean dialogue-forward production sound with restrained room tone and synchronized Foley.',
    music: 'A minimal underscore at low volume that never masks dialogue.',
    recommendedPreset: 'master720',
  }),
  product: Object.freeze({
    id: 'product',
    label: '商品展示',
    description: '保持商品轮廓、材质、标识位置与高光走向，限制无关形变。',
    style: 'Premium commercial product cinematography, clean composition, precise material response, controlled studio lighting',
    continuity: 'Preserve product silhouette, proportions, surface markings, material, label placement, and lighting continuity without adding parts.',
    soundscape: 'Subtle synchronized material and handling sounds in a clean studio acoustic space.',
    music: 'A restrained modern pulse with sparse percussion and no vocals.',
    recommendedPreset: 'master720',
  }),
  portrait: Object.freeze({
    id: 'portrait',
    label: '人像微动',
    description: '采用小幅自然动作，重点保护面部、手部、服装与背景稳定。',
    style: 'Natural cinematic portrait, stable facial anatomy, realistic skin texture, soft directional lighting',
    continuity: 'Preserve facial identity, hairstyle, hands, clothing details, body proportions, and background layout; use subtle continuous motion.',
    soundscape: 'Quiet natural room tone with subtle breathing, fabric movement, and synchronized environmental detail.',
    music: 'N/A',
    recommendedPreset: 'balanced',
  }),
  illustration: Object.freeze({
    id: 'illustration',
    label: '插画动画',
    description: '保护线稿、色块、角色造型与二维风格，避免写实化漂移。',
    style: 'High-quality 2D animation, coherent linework, stable color blocks, consistent character design',
    continuity: 'Preserve line weight, palette, character proportions, costume shapes, and background perspective without drifting into photorealism.',
    soundscape: 'Stylized but synchronized ambience and Foley matching the animated action.',
    music: 'A light instrumental arrangement with a clear rhythm and no vocals unless explicitly requested.',
    recommendedPreset: 'master720',
  }),
})

const MODES = new Set(['text-to-video', 'image-to-video'])
const CAMERA = Object.freeze({
  locked: 'The camera holds a static shot with a stable composition.',
  'push-in': 'The camera pushes in with small amplitude at slow speed toward the primary subject.',
  pan: 'The camera pans laterally with small amplitude at slow speed while preserving spatial orientation.',
  orbit: 'The camera performs a controlled arc shot around the primary subject at moderate speed.',
  follow: 'The camera uses a smooth tracking shot that keeps the primary subject clearly framed.',
})
const MOTION = Object.freeze({
  subtle: 'Subject motion remains subtle, continuous, and limited to small displacement.',
  natural: 'Subject motion has natural pacing, believable weight, anticipation, and follow-through.',
  dynamic: 'Subject motion is energetic but remains readable, physically coherent, and free of temporal smearing.',
})

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

function compact(value, maxLength) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxLength)
}

function extractStructuredField(source, field, nextField) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const end = nextField
    ? `(?=\\n\\s*${nextField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:)`
    : '$'
  return new RegExp(`${escaped}\\s*:\\s*([\\s\\S]*?)${end}`, 'i').exec(source)?.[1]?.trim()
}

function parseStructuredPrompt(source) {
  if (!/integrated_multimodal_description\s*:/i.test(source)) return null
  const integrated = extractStructuredField(source, 'integrated_multimodal_description', 'overall_soundscape')
  const soundscape = extractStructuredField(source, 'overall_soundscape', 'non_diegetic_music')
  const music = extractStructuredField(source, 'non_diegetic_music')
  if (!integrated) return null
  return { integrated, soundscape, music }
}

function inferScenario(source, aspectRatio) {
  if (/商品|产品|包装|广告|commercial|product|packshot|logo/i.test(source)) return 'product'
  if (/人像|肖像|面部|微笑|眨眼|portrait|headshot|face/i.test(source)) return 'portrait'
  if (/动漫|动画|插画|像素|二次元|anime|animation|illustration|cartoon/i.test(source)) return 'illustration'
  if (/对白|对话|台词|旁白|解说|短剧|口播|dialogue|voiceover|narration/i.test(source) || aspectRatio === '9:16') return 'shortDrama'
  return 'cinematic'
}

function alignmentInstruction(mode, hasLastFrame, effectiveDurationSeconds) {
  if (mode !== 'image-to-video') return ''
  if (hasLastFrame) {
    return `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${effectiveDurationSeconds.toFixed(2)}-second mark of the target video.`
  }
  return 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.'
}

function referenceAnchor(mode, hasLastFrame) {
  if (mode !== 'image-to-video') return ''
  if (hasLastFrame) {
    return 'Use <Picture 1> as the exact opening state and continuously develop the visible action until the composition, subject pose, and scene state naturally reach <Picture 2> at the end.'
  }
  return 'Use <Picture 1> as the exact first frame; preserve its subject identity, composition, wardrobe, objects, colors, and scene layout as the action develops forward.'
}

function safeDirector(input = {}) {
  const camera = Object.hasOwn(CAMERA, input.camera) ? input.camera : 'locked'
  const motion = Object.hasOwn(MOTION, input.motion) ? input.motion : 'natural'
  return {
    camera,
    motion,
    continuity: input.continuity !== false,
    soundscape: compact(input.soundscape, 800),
    music: compact(input.music, 800),
    constraints: compact(input.constraints, 800),
  }
}

function formatTimestamp(value) {
  return Number(value).toFixed(2)
}

function hasTimedShotSyntax(value) {
  return /(?:\[\s*\d+(?:\.\d+)?\s*s?\s*[-–—]\s*\d+(?:\.\d+)?\s*s?\s*\]|\[Shot\s+\d+\]|\b\d+(?:\.\d+)?\s*seconds?\b)/i.test(value)
}

function buildShotPlan(sourceBody, effectiveDurationSeconds, mode) {
  if (hasTimedShotSyntax(sourceBody)) {
    return [{
      start: 0,
      end: effectiveDurationSeconds,
      role: 'user-timed',
      instruction: sourceBody,
    }]
  }
  const boundaries = effectiveDurationSeconds <= 5.2
    ? [0, 0.22, 0.78, 1]
    : [0, 0.15, 0.48, 0.8, 1]
  const roles = boundaries.length === 4
    ? ['establish', 'develop', 'resolve']
    : ['establish', 'initiate', 'develop', 'resolve']
  const instructions = {
    establish: `${mode === 'image-to-video' ? 'Hold the supplied opening identity and composition while establishing' : 'Establish'} the scene, primary subject, spatial layout, lighting, and visual style. Creative intent: ${sourceBody}`,
    initiate: 'Begin the requested primary action with readable anticipation; keep camera movement smooth and preserve screen direction.',
    develop: 'Develop the primary action continuously with believable weight, stable anatomy, coherent occlusion, synchronized environmental response, and no unrequested cut.',
    resolve: 'Resolve the action into a clear final pose or scene state; reduce residual motion and hold identity, geometry, lighting, and composition stable through the last frame.',
  }
  return roles.map((role, index) => ({
    start: effectiveDurationSeconds * boundaries[index],
    end: effectiveDurationSeconds * boundaries[index + 1],
    role,
    instruction: instructions[role],
  }))
}

export function compileH3Prompt(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_H3_PROMPT_REQUEST', 'H3 prompt request must be an object')
  const mode = input.mode
  if (!MODES.has(mode)) fail('INVALID_H3_PROMPT_MODE', 'Unsupported H3 prompt mode')
  const sourcePrompt = compact(input.sourcePrompt ?? input.prompt, 8_000)
  if (sourcePrompt.length < 2) fail('INVALID_H3_SOURCE_PROMPT', 'H3 source prompt must contain at least two characters')
  const duration = Number(input.duration)
  if (!Object.hasOwn(VIDEO_DURATION_FRAMES, duration)) fail('INVALID_H3_PROMPT_DURATION', 'Unsupported H3 prompt duration')
  const frames = Number.isInteger(input.frameCount) && input.frameCount > 1 ? input.frameCount : VIDEO_DURATION_FRAMES[duration]
  const effectiveDurationSeconds = (frames - 1) / 24
  const requestedScenario = Object.hasOwn(H3_SCENARIO_PRESETS, input.scenario) ? input.scenario : 'auto'
  const resolvedScenario = requestedScenario === 'auto'
    ? inferScenario(sourcePrompt, input.aspectRatio)
    : requestedScenario
  const scenario = H3_SCENARIO_PRESETS[resolvedScenario]
  const director = safeDirector(input.director)
  const structured = parseStructuredPrompt(sourcePrompt)
  const alignment = alignmentInstruction(mode, Boolean(input.hasLastFrame), effectiveDurationSeconds)
  const anchor = referenceAnchor(mode, Boolean(input.hasLastFrame))
  const sourceBody = structured?.integrated || sourcePrompt
  const shotPlan = buildShotPlan(sourceBody, effectiveDurationSeconds, mode)
  const timeline = shotPlan.map((beat) => (
    `[${formatTimestamp(beat.start)}s–${formatTimestamp(beat.end)}s] ${beat.instruction}`
  )).join('\n')
  const continuity = director.continuity
    ? scenario.continuity
    : 'Allow deliberate scene evolution while keeping the primary subject recognizable and the visual transition motivated.'
  const constraints = director.constraints
    ? `Additional visual constraints: ${director.constraints}`
    : 'Keep the frame free of autogenerated subtitles, watermarks, duplicate subjects, broken anatomy, and abrupt unrequested morphing.'
  const integrated = [
    `[Shot 1] ${scenario.style}.`,
    anchor,
    timeline,
    CAMERA[director.camera],
    MOTION[director.motion],
    continuity,
    constraints,
  ].filter(Boolean).join('\n')
  const audio = input.audio !== false
  const soundscape = audio
    ? `${director.soundscape || structured?.soundscape || scenario.soundscape} Synchronize every audible event to its visible cause and keep dialogue intelligible.`
    : 'N/A'
  const music = audio
    ? director.music || structured?.music || scenario.music
    : 'N/A'
  const sections = {
    alignment,
    integratedMultimodalDescription: integrated,
    overallSoundscape: soundscape,
    nonDiegeticMusic: music,
  }
  let compiledPrompt = [
    alignment,
    `integrated_multimodal_description: ${integrated}`,
    `overall_soundscape: ${soundscape}`,
    `non_diegetic_music: ${music}`,
  ].filter(Boolean).join('\n\n')
  if (compiledPrompt.length > 8_000) {
    const overflow = compiledPrompt.length - 8_000
    const shortened = integrated.slice(0, Math.max(200, integrated.length - overflow - 16)).trim()
    sections.integratedMultimodalDescription = shortened
    compiledPrompt = [
      alignment,
      `integrated_multimodal_description: ${shortened}`,
      `overall_soundscape: ${soundscape}`,
      `non_diegetic_music: ${music}`,
    ].filter(Boolean).join('\n\n').slice(0, 8_000)
  }
  const warnings = []
  if (director.motion === 'dynamic' && duration === 5) {
    warnings.push('5 秒强运动对 Turbo 更敏感；正式母版优先使用 Base 20 步，或降低单镜头位移与转速。')
  }
  if (Boolean(input.hasLastFrame) && director.motion === 'dynamic') {
    warnings.push('首尾帧约束与强运动同时使用时，应确保两张参考图之间存在连续可达的动作路径。')
  }
  if (structured) warnings.push('检测到既有 H3 结构，已保留主体描述并按当前场景、镜头和声画字段重新规范化。')
  if (hasTimedShotSyntax(sourceBody)) warnings.push('检测到用户时间轴，已原样保留时间标记，不再自动拆分节拍。')
  return {
    schemaVersion: H3_PROMPT_AGENT_SCHEMA_VERSION,
    agentVersion: H3_PROMPT_AGENT_VERSION,
    mode: mode === 'text-to-video' ? 'T2VA' : input.hasLastFrame ? 'FL2VA' : 'I2VA',
    requestedScenario,
    resolvedScenario,
    recommendedPreset: scenario.recommendedPreset,
    effectiveDurationSeconds,
    shotPlan,
    qualityGuidance: {
      nativeMaster: duration === 5 ? '1344×768 Turbo 适合短镜头原生母版。' : '长镜头优先 1024×576，避免 8GB 时空注意力峰值。',
      finalMaster: '正式成片优先 Base 20 步；需要标准 720P 时再串联 SeedVR2 时序修复。',
    },
    sourcePrompt,
    compiledPrompt,
    sections,
    warnings,
  }
}

export function h3PromptAgentCatalog() {
  return {
    schemaVersion: H3_PROMPT_AGENT_SCHEMA_VERSION,
    version: H3_PROMPT_AGENT_VERSION,
    scenarios: Object.values(H3_SCENARIO_PRESETS),
    fields: ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'],
  }
}
