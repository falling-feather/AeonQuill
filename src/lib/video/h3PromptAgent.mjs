export const H3_PROMPT_AGENT_SCHEMA_VERSION = 1
export const H3_PROMPT_AGENT_VERSION = 'aeonquill-h3-context-lite-v1'

export const H3_SCENARIO_PRESETS = Object.freeze({
  auto: Object.freeze({
    id: 'auto',
    label: '智能匹配',
    description: '根据主体、对白、画幅与动作强度选择受控场景结构。',
    recommendedPreset: 'delivery720',
  }),
  cinematic: Object.freeze({
    id: 'cinematic',
    label: '电影叙事',
    description: '强调镜头语言、光线层次、空间连续性与自然声画同步。',
    style: 'Live-action, cinematic, coherent lighting, physically believable motion',
    continuity: 'Maintain subject identity, wardrobe, scene geometry, lighting direction, and screen direction throughout the shot.',
    soundscape: 'Natural synchronized ambience and physical action sounds matching every visible movement.',
    music: 'Sparse cinematic instrumentation at a restrained tempo, with dynamics following the visible action.',
    recommendedPreset: 'delivery720',
  }),
  shortDrama: Object.freeze({
    id: 'shortDrama',
    label: '竖屏短剧',
    description: '优先人物身份、对白可懂度、面部稳定与有限镜头调度。',
    style: 'Live-action short drama, clear facial detail, readable blocking, controlled depth of field',
    continuity: 'Keep every speaker visually consistent, preserve eyelines and lip synchronization, and avoid unmotivated cuts or background changes.',
    soundscape: 'Clean dialogue-forward production sound with restrained room tone and synchronized Foley.',
    music: 'A minimal underscore at low volume that never masks dialogue.',
    recommendedPreset: 'delivery720',
  }),
  product: Object.freeze({
    id: 'product',
    label: '商品展示',
    description: '保持商品轮廓、材质、标识位置与高光走向，限制无关形变。',
    style: 'Premium commercial product cinematography, clean composition, precise material response, controlled studio lighting',
    continuity: 'Preserve product silhouette, proportions, surface markings, material, label placement, and lighting continuity without adding parts.',
    soundscape: 'Subtle synchronized material and handling sounds in a clean studio acoustic space.',
    music: 'A restrained modern pulse with sparse percussion and no vocals.',
    recommendedPreset: 'delivery720',
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
    recommendedPreset: 'delivery720',
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

export function compileH3Prompt(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_H3_PROMPT_REQUEST', 'H3 prompt request must be an object')
  const mode = input.mode
  if (!MODES.has(mode)) fail('INVALID_H3_PROMPT_MODE', 'Unsupported H3 prompt mode')
  const sourcePrompt = compact(input.sourcePrompt ?? input.prompt, 8_000)
  if (sourcePrompt.length < 2) fail('INVALID_H3_SOURCE_PROMPT', 'H3 source prompt must contain at least two characters')
  const duration = Number(input.duration)
  if (![5, 10, 15].includes(duration)) fail('INVALID_H3_PROMPT_DURATION', 'H3 prompt duration must be 5, 10, or 15 seconds')
  const frames = Number.isInteger(input.frameCount) && input.frameCount > 1 ? input.frameCount : Math.round(duration * 24)
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
  const continuity = director.continuity
    ? scenario.continuity
    : 'Allow deliberate scene evolution while keeping the primary subject recognizable and the visual transition motivated.'
  const constraints = director.constraints
    ? `Additional visual constraints: ${director.constraints}`
    : 'Keep the frame free of autogenerated subtitles, watermarks, duplicate subjects, broken anatomy, and abrupt unrequested morphing.'
  const integrated = [
    `[Shot 1] ${scenario.style}.`,
    anchor,
    sourceBody,
    CAMERA[director.camera],
    MOTION[director.motion],
    continuity,
    constraints,
  ].filter(Boolean).join(' ')
  const audio = input.audio !== false
  const soundscape = audio
    ? director.soundscape || structured?.soundscape || scenario.soundscape
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
    warnings.push('5 秒强运动对 Turbo 采样更敏感；若出现拖影，优先使用 6–8 步质量档或降低运动幅度。')
  }
  if (Boolean(input.hasLastFrame) && director.motion === 'dynamic') {
    warnings.push('首尾帧约束与强运动同时使用时，应确保两张参考图之间存在连续可达的动作路径。')
  }
  if (structured) warnings.push('检测到既有 H3 结构，已保留主体描述并按当前场景、镜头和声画字段重新规范化。')
  return {
    schemaVersion: H3_PROMPT_AGENT_SCHEMA_VERSION,
    agentVersion: H3_PROMPT_AGENT_VERSION,
    mode: mode === 'text-to-video' ? 'T2VA' : input.hasLastFrame ? 'FL2VA' : 'I2VA',
    requestedScenario,
    resolvedScenario,
    recommendedPreset: scenario.recommendedPreset,
    effectiveDurationSeconds,
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
