export type H3ScenarioId = 'auto' | 'cinematic' | 'shortDrama' | 'product' | 'portrait' | 'illustration'

export type H3PromptDirector = {
  camera: 'locked' | 'push-in' | 'pan' | 'orbit' | 'follow'
  motion: 'subtle' | 'natural' | 'dynamic'
  continuity: boolean
  soundscape: string
  music: string
  constraints: string
}

export type H3PromptPlan = {
  schemaVersion: 1
  agentVersion: string
  mode: 'T2VA' | 'I2VA' | 'FL2VA'
  requestedScenario: H3ScenarioId
  resolvedScenario: Exclude<H3ScenarioId, 'auto'>
  recommendedPreset: 'balanced' | 'delivery720'
  effectiveDurationSeconds: number
  sourcePrompt: string
  compiledPrompt: string
  sections: {
    alignment: string
    integratedMultimodalDescription: string
    overallSoundscape: string
    nonDiegeticMusic: string
  }
  warnings: string[]
}

export const H3_PROMPT_AGENT_SCHEMA_VERSION: 1
export const H3_PROMPT_AGENT_VERSION: string
export const H3_SCENARIO_PRESETS: Readonly<Record<H3ScenarioId, Readonly<{
  id: H3ScenarioId
  label: string
  description: string
  recommendedPreset: 'balanced' | 'delivery720'
  style?: string
  continuity?: string
  soundscape?: string
  music?: string
}>>>

export function compileH3Prompt(input: {
  mode: 'text-to-video' | 'image-to-video'
  sourcePrompt?: string
  prompt?: string
  scenario?: H3ScenarioId
  aspectRatio?: '16:9' | '9:16' | '1:1'
  duration: 5 | 10 | 15
  frameCount?: number
  audio?: boolean
  hasLastFrame?: boolean
  director?: Partial<H3PromptDirector>
}): H3PromptPlan

export function h3PromptAgentCatalog(): {
  schemaVersion: 1
  version: string
  scenarios: Array<(typeof H3_SCENARIO_PRESETS)[H3ScenarioId]>
  fields: string[]
}
