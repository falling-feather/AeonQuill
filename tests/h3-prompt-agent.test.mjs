import assert from 'node:assert/strict'
import test from 'node:test'
import {
  H3_PROMPT_AGENT_VERSION,
  compileH3Prompt,
  h3PromptAgentCatalog,
} from '../src/lib/video/h3PromptAgent.mjs'

test('compiles free-form T2VA into the official three-section order', () => {
  const plan = compileH3Prompt({
    mode: 'text-to-video',
    sourcePrompt: '雨夜书店里，一名年轻人推门走向柜台。',
    scenario: 'cinematic',
    aspectRatio: '16:9',
    duration: 5,
    frameCount: 124,
    audio: true,
    director: {
      camera: 'push-in',
      motion: 'natural',
      continuity: true,
      soundscape: '雨声、门铃与脚步声同步。',
      music: '低音弦乐缓慢铺开。',
      constraints: '不生成字幕。',
    },
  })
  assert.equal(plan.agentVersion, H3_PROMPT_AGENT_VERSION)
  assert.equal(plan.mode, 'T2VA')
  assert.equal(plan.resolvedScenario, 'cinematic')
  assert.equal(plan.sections.alignment, '')
  assert.ok(plan.compiledPrompt.indexOf('integrated_multimodal_description:') < plan.compiledPrompt.indexOf('overall_soundscape:'))
  assert.ok(plan.compiledPrompt.indexOf('overall_soundscape:') < plan.compiledPrompt.indexOf('non_diegetic_music:'))
  assert.match(plan.compiledPrompt, /pushes in with small amplitude at slow speed/)
  assert.ok(plan.compiledPrompt.length <= 8_000)
})

test('adds exact first/last-frame alignment and preserves source identity constraints', () => {
  const plan = compileH3Prompt({
    mode: 'image-to-video',
    sourcePrompt: '角色从静止姿势缓慢抬头，最终看向镜头。',
    scenario: 'portrait',
    aspectRatio: '9:16',
    duration: 5,
    frameCount: 124,
    audio: false,
    hasLastFrame: true,
    director: { camera: 'locked', motion: 'subtle', continuity: true },
  })
  assert.equal(plan.mode, 'FL2VA')
  assert.match(plan.sections.alignment, /Picture 1.*0\.00-second.*Picture 2.*5\.13-second/)
  assert.match(plan.sections.integratedMultimodalDescription, /exact opening state/)
  assert.equal(plan.sections.overallSoundscape, 'N/A')
  assert.equal(plan.sections.nonDiegeticMusic, 'N/A')
})

test('auto-routes product, portrait, illustration, and vertical dialogue scenarios deterministically', () => {
  const compile = (sourcePrompt, aspectRatio = '16:9') => compileH3Prompt({
    mode: 'text-to-video', sourcePrompt, scenario: 'auto', aspectRatio, duration: 5,
  }).resolvedScenario
  assert.equal(compile('高端香水产品广告，展示玻璃材质与包装。'), 'product')
  assert.equal(compile('人物肖像轻轻眨眼。'), 'portrait')
  assert.equal(compile('二维动漫角色奔跑。'), 'illustration')
  assert.equal(compile('两个人在雨中对话。'), 'shortDrama')
  assert.equal(compile('普通人物走进咖啡店。', '9:16'), 'shortDrama')
})

test('normalizes existing structured prompts instead of nesting duplicate field headers', () => {
  const plan = compileH3Prompt({
    mode: 'text-to-video',
    sourcePrompt: 'integrated_multimodal_description: [Shot 1] A quiet lake.\noverall_soundscape: Soft water.\nnon_diegetic_music: N/A',
    scenario: 'cinematic',
    duration: 5,
    audio: true,
  })
  assert.equal((plan.compiledPrompt.match(/integrated_multimodal_description:/g) || []).length, 1)
  assert.equal((plan.compiledPrompt.match(/overall_soundscape:/g) || []).length, 1)
  assert.equal((plan.compiledPrompt.match(/non_diegetic_music:/g) || []).length, 1)
  assert.ok(plan.warnings.some((warning) => warning.includes('既有 H3 结构')))
})

test('publishes a stable prompt-agent catalog', () => {
  const catalog = h3PromptAgentCatalog()
  assert.equal(catalog.version, H3_PROMPT_AGENT_VERSION)
  assert.deepEqual(catalog.fields, [
    'integrated_multimodal_description',
    'overall_soundscape',
    'non_diegetic_music',
  ])
  assert.ok(catalog.scenarios.some(({ id }) => id === 'shortDrama'))
})
